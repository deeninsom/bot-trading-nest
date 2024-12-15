import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotV6Service implements OnModuleInit {
  private accountId = process.env.ACC_ID;
  private readonly logger = new Logger(BotV6Service.name);
  private api = new MetaApi(process.env.TOKEN);
  private connection = null;
  private account = null;
  private pair = 'LTCJPY';
  private baseVolume = 0.01; // Volume dasar
  private volume = this.baseVolume;
  private takeProfit = 1.190;
  private stopLoss = 0.500;

  private lastAction: 'BUY' | 'SELL' | null = null; // Menyimpan tindakan terakhir
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

      const currentMinute = new Date().getMinutes();
      if (currentMinute % 5 === 0) {
        const canOpenOrder = await this.cekOrderOpened(this.connection);
        if (canOpenOrder && (await this.canEnterNewPosition())) {
          await this.openPositionWithDAlembert(price);
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

  private async openPositionWithDAlembert(currentPrice: number) {
    try {
      const spread = await this.getSpread();

      // Tentukan tindakan berikutnya berdasarkan pola D’Alembert
      const nextAction = this.lastAction === 'BUY' ? 'SELL' : 'BUY';

      if (nextAction === 'BUY') {
        await this.openBuyPosition(currentPrice, spread);
      } else {
        await this.openSellPosition(currentPrice, spread);
      }

      this.lastAction = nextAction; // Perbarui tindakan terakhir
    } catch (error) {
      this.logger.error('Error opening position with D’Alembert', error);
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
        { comment: 'Buy based on D’Alembert' }
      );
      this.logger.log('Buy position opened:', order);

      // Kurangi volume setelah menang
      this.volume = Math.max(this.baseVolume, this.volume - this.baseVolume);
    } catch (error) {
      this.logger.error('Error opening buy position', error);

      // Tambahkan volume setelah kalah
      this.volume += this.baseVolume;
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
        { comment: 'Sell based on D’Alembert' }
      );
      this.logger.log('Sell position opened:', order);

      // Kurangi volume setelah menang
      this.volume = Math.max(this.baseVolume, this.volume - this.baseVolume);
    } catch (error) {
      this.logger.error('Error opening sell position', error);

      // Tambahkan volume setelah kalah
      this.volume += this.baseVolume;
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

  private scheduleNextFetch() {
    setInterval(async () => {
      await this.analyzeTrend();
    }, 60000); // Eksekusi setiap 1 menit
  }
}
