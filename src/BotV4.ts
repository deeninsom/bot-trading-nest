import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotV4Service implements OnModuleInit {
  private accountId = process.env.ACC_ID;
  private readonly logger = new Logger(BotV4Service.name);
  private api = new MetaApi(process.env.TOKEN);
  private connection = null;
  private account = null;
  private pair = 'USDJPY';
  private volume = 0.01;
  private takeProfit = 0.190;
  private stopLoss = 0.090;

  private lastPrice: number | null = null;
  private lastEntryTime: number | null = null;

  async onModuleInit() {
    await this.initializeMetaApi();
    this.scheduleNextFetch();
  }

  private async initializeMetaApi() {
    try {
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);
      this.logger.log('Deploying account');
      await this.account.deploy();

      this.logger.log('Waiting for API server to connect to broker');
      await this.account.waitConnected();

      this.connection = this.account.getStreamingConnection();
      this.logger.log('Waiting for SDK to synchronize to terminal state');
      await this.connection.connect();
      await this.connection.waitSynchronized();

      this.logger.log('Connected and synchronized');
    } catch (error) {
      this.logger.error('Error during MetaApi connection', error);
    }
  }

  private async fetchRealTimePrice() {
    try {
      const marketData = await this.connection.subscribeToMarketData(this.pair);
      return marketData.ask; // Mengembalikan harga ask
    } catch (error) {
      this.logger.error('Error fetching real-time price', error);
      return null;
    }
  }

  private async analyzeTrend() {
    try {
      const price = await this.fetchRealTimePrice();
      if (price === null) {
        this.logger.warn('No price data available');
        return;
      }

      let trend = 'NEUTRAL';
      if (this.lastPrice !== null) {
        trend = price > this.lastPrice ? 'UP' : price < this.lastPrice ? 'DOWN' : 'NEUTRAL';
        this.logger.log(`Price is ${trend === 'UP' ? 'increasing' : trend === 'DOWN' ? 'decreasing' : 'stable'}`);
      }

      this.lastPrice = Number(price.toFixed(3));

      const trend1m = await this.getTrendOnTimeframe('1m');
      const trend5m = await this.getTrendOnTimeframe('5m');
      const isBOS = await this.detectBOS(price);

      if (!(trend1m === trend5m && isBOS)) {
        this.logger.log('Trend not confirmed across timeframes or no BOS detected, skipping entry');
        return;
      }

      const currentMinute = new Date().getMinutes();
      if (currentMinute % 5 === 0) {
        const canOpenOrder = await this.cekOrderOpened(this.connection);
        if (canOpenOrder && (await this.canEnterNewPosition())) {
          await this.openPositionBasedOnTrend(trend, price);
        } else {
          this.logger.log('Conditions not met for new position. Skipping entry.');
        }
      } else {
        this.logger.log(`Current minute: ${currentMinute}. Waiting for 5-minute mark.`);
      }
    } catch (error) {
      this.logger.error('Error analyzing trend', error);
    }
  }

  private async openPositionBasedOnTrend(trend: string, currentPrice: number) {
    try {
      const spread = await this.getSpread();
      if (trend === 'UP') {
        await this.openBuyPosition(currentPrice, spread);
      } else if (trend === 'DOWN') {
        await this.openSellPosition(currentPrice, spread);
      } else {
        this.logger.log('No action taken, trend is neutral.');
      }
    } catch (error) {
      this.logger.error('Error opening position based on trend', error);
    }
  }

  private async getSpread(): Promise<number> {
    try {
      const marketData = await this.connection.subscribeToMarketData(this.pair);
      return marketData.ask - marketData.bid;
    } catch (error) {
      this.logger.error('Error fetching market spread', error);
      return 0;
    }
  }

  private async openBuyPosition(currentPrice: number, spread: number) {
    try {
      const price = Number(currentPrice);
      const targetTp = price + this.takeProfit + spread;
      const targetLoss = price - this.stopLoss - spread;

      const order = await this.connection.createMarketBuyOrder(
        this.pair,
        this.volume,
        targetLoss,
        targetTp,
        { comment: 'Buy based on trend' }
      );
      this.logger.log('Buy position opened:', order);
    } catch (error) {
      this.logger.error('Error opening buy position', error);
    }
  }

  private async openSellPosition(currentPrice: number, spread: number) {
    try {
      const price = Number(currentPrice);
      const targetTp = price - this.takeProfit - spread;
      const targetLoss = price + this.stopLoss + spread;

      const order = await this.connection.createMarketSellOrder(
        this.pair,
        this.volume,
        targetLoss,
        targetTp,
        { comment: 'Sell based on trend' }
      );
      this.logger.log('Sell position opened:', order);
    } catch (error) {
      this.logger.error('Error opening sell position', error);
    }
  }

  private async cekOrderOpened(connection: any) {
    try {
      const terminalState = connection.terminalState;
      const openPositions = terminalState.positions;
      return openPositions.length < 2;
    } catch (error) {
      this.logger.error('Error checking open orders', error);
      return false;
    }
  }

  private async canEnterNewPosition(): Promise<boolean> {
    const now = Date.now();
    if (this.lastEntryTime && now - this.lastEntryTime < 5 * 60 * 1000) {
      this.logger.log('Skipping entry, last entry was less than 5 minutes ago');
      return false;
    }
    this.lastEntryTime = now;
    return true;
  }

  private async detectBOS(currentPrice: number): Promise<boolean> {
    try {
      const history = await this.account.getHistoricalCandles(this.pair, '1m', 10);
      const recentHigh = Math.max(...history.map(candle => Number(candle.high)));
      const recentLow = Math.min(...history.map(candle => Number(candle.low)));
      return currentPrice > recentHigh || currentPrice < recentLow;
    } catch (error) {
      this.logger.error('Error detecting BOS', error);
      return false;
    }
  }

  private async getTrendOnTimeframe(timeframe: string): Promise<string> {
    try {
      const history = await this.account.getHistoricalCandles(this.pair, timeframe, 5);
      const recentClose = history.map(candle => Number(candle.close));
      return recentClose[4] > recentClose[0] ? 'UP' : 'DOWN';
    } catch (error) {
      this.logger.error('Error fetching trend on timeframe', error);
      return 'NEUTRAL';
    }
  }

  private scheduleNextFetch() {
    setInterval(async () => {
      await this.analyzeTrend();
    }, 60000); // Eksekusi setiap 1 menit
  }
}
