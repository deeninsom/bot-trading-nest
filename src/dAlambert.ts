import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotV6Service implements OnModuleInit {
  private accountId = process.env.ACC_ID;
  private readonly logger = new Logger(BotV6Service.name);
  private api = new MetaApi(process.env.TOKEN);
  private connection = null;
  private account = null;
  private pair = 'USDJPY';
  private baseVolume = 0.01; // Base volume
  private volume = this.baseVolume; // Current volume used for trading
  private lastEntryTime: number | null = null;
  private lastTradeResult: string = 'NONE'; // Track WIN or LOSE for Martingale strategy

  async onModuleInit() {
    await this.initializeMetaApi();
    this.scheduleNextFetch();
  }

  private async initializeMetaApi() {
    try {
      // Get account and initialize connection
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);
      this.logger.log('Deploying account');
      await this.account.deploy();
      await this.account.waitConnected();

      this.connection = this.account.getStreamingConnection();
      await this.connection.connect();
      await this.connection.waitSynchronized();
      this.logger.log('MetaApi connection established');
    } catch (error) {
      this.logger.error('Error during MetaApi connection', error);
    }
  }

  private async fetchRealTimePrice() {
    try {
      const marketData = await this.connection.subscribeToMarketData(this.pair);
      if (marketData && marketData.ask) {
        return marketData.ask; // Return the ask price
      }
      return null;
    } catch (error) {
      this.logger.error('Error fetching real-time price', error);
      return null;
    }
  }

  private async getLastTwoCandles() {
    try {
      const candles = await this.account.getHistoricalCandles(this.pair, '15m');
      if (candles.length >= 4) {
        return candles.slice(-4); // Get the last two candles
      }
      return null;
    } catch (error) {
      this.logger.error('Error fetching last two candles', error);
      return null;
    }
  }

  private async analyzeTrend() {
    try {
      const price = await this.fetchRealTimePrice();
      if (!price) return;

      const lastTwoCandles = await this.getLastTwoCandles();
      if (!lastTwoCandles || lastTwoCandles.length !== 4) {
        this.logger.log('Insufficient candle data');
        return;
      }

      const [previousCandle, currentCandle] = lastTwoCandles;

      const trendIsUp = currentCandle.close > previousCandle.close;
      const trendIsDown = currentCandle.close < previousCandle.close;

      if (await this.cekOrderOpened()) {
        const canEnterPosition = await this.canEnterNewPosition();
        if (canEnterPosition) {
          if (trendIsUp) {
            await this.openPosition(price, 'BUY');
            this.logger.log('Opening BUY position due to uptrend');
          } else if (trendIsDown) {
            await this.openPosition(price, 'SELL');
            this.logger.log('Opening SELL position due to downtrend');
          } else {
            this.logger.log('No clear trend detected');
          }
        } else {
          this.logger.log('Waiting for the next entry opportunity');
        }
      }
    } catch (error) {
      this.logger.error('Error analyzing trend:', error);
    }
  }

  private async openPosition(currentPrice: number, position: string) {
    try {
      if (position === 'BUY') {
        await this.openBuyPosition();
      } else if (position === 'SELL') {
        await this.openSellPosition();
      }
    } catch (error) {
      this.logger.error('Error opening position', error);
    }
  }

  private async openBuyPosition() {
    try {
      const order = await this.connection.createMarketBuyOrder(this.pair, this.volume);
      this.logger.log('Buy position opened:', order);
    } catch (error) {
      this.logger.error('Error opening buy position', error);
    }
  }

  private async openSellPosition() {
    try {
      const order = await this.connection.createMarketSellOrder(this.pair, this.volume);
      this.logger.log('Sell position opened:', order);
    } catch (error) {
      this.logger.error('Error opening sell position', error);
    }
  }

  private async cekOrderOpened(): Promise<boolean> {
    try {
      const openPositions = this.connection.terminalState.positions;
      return openPositions.length <= 0; // Can only open new position if none are open
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

  private async realTimeCheckOrderOpened() {
    const openPositions = this.connection.terminalState.positions;
    for (const position of openPositions) {
      const profit = position.unrealizedProfit;
      console.log({
        id_order: position.id,
        profit: profit
      })
      if (profit.toFixed(1) < -1.1) {
        await this.connection.closePosition(position.id);
        this.logger.log(`Closed position ${position.id} with profit: ${profit}`);
        console.log('MOHON MAAF ANDA KALAH')
      }else if(profit.toFixed(1) > 2.1){
        await this.connection.closePosition(position.id);
        this.logger.log(`Closed position ${position.id} with profit: ${profit}`);
        console.log('SELAMAT ANDA MENANG')
      }
    }
  }

  private scheduleNextFetch() {
    setInterval(async () => {
      await this.analyzeTrend();
      await this.realTimeCheckOrderOpened()
    }, 3000); // Execute every 3 seconds
  }
}
