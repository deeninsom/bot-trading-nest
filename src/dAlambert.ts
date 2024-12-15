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

  private lastAction: 'BUY' | 'SELL' | null = null; // Menyimpan tindakan terakhir
  private lastEntryTime: number | null = null;
  private highestProfit: number = 0; // Menyimpan profit tertinggi

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
      this.logger.log('Connected and synchronized');
      await this.connection.connect();
      await this.connection.waitSynchronized();
    } catch (error) {
      this.logger.error('Error during MetaApi connection', error);
    }
  }

  private async fetchRealTimePrice() {
    try {
      const marketData = await this.connection.subscribeToMarketData(this.pair);
      return marketData.ask;
    } catch (error) {
      this.logger.error('Error fetching real-time price', error);
      return null;
    }
  }

  private async analyzeTrend() {
    try {
      const price = await this.fetchRealTimePrice();
      if (!price) return;

      const canOpenOrder = await this.cekOrderOpened(this.connection);

      // Jika tidak ada order terbuka, buka posisi baru
      if (canOpenOrder && (await this.canEnterNewPosition())) {
        await this.openPosition(price);
      } else {
        await this.manageOpenOrders();
      }
    } catch (error) {
      this.logger.error('Error analyzing trend', error);
    }
  }

  private async openPosition(currentPrice: number) {
    try {
      const nextAction = this.lastAction === 'BUY' ? 'SELL' : 'BUY';
      const spread = await this.getSpread();

      if (nextAction === 'BUY') {
        await this.openBuyPosition();
      } else {
        await this.openSellPosition();
      }

      this.lastAction = nextAction;
      this.highestProfit = 0; // Reset profit tertinggi saat posisi baru dibuka
    } catch (error) {
      this.logger.error('Error opening position', error);
    }
  }

  private async openBuyPosition() {
    const order = await this.connection.createMarketBuyOrder(
      this.pair,
      this.volume
    );
    this.logger.log('Buy position opened:', order);
  }

  private async openSellPosition() {
    const order = await this.connection.createMarketSellOrder(
      this.pair,
      this.volume
    );
    this.logger.log('Sell position opened:', order);
  }

  private async manageOpenOrders() {
    try {
      const openPositions = this.connection.terminalState.positions;
      let totalProfit = 0;

      for (const position of openPositions) {
        totalProfit += position.profit;

        // Simpan profit tertinggi
        if (position.profit > this.highestProfit) {
          this.highestProfit = position.profit;
        }

        // Jika profit menurun hingga setengah dari puncak, tutup posisi
        if (position.profit <= this.highestProfit / 2) {
          await this.closePosition(position);
          this.logger.log(
            `Position closed due to profit drop. Highest: ${this.highestProfit}, Current: ${position.profit}`
          );
        }
      }

      // Tutup semua posisi jika total profit mencapai atau melebihi $1
      if (totalProfit >= 1) {
        for (const position of openPositions) {
          await this.closePosition(position.positionId);
        }
        this.logger.log(`All positions closed. Total profit: ${totalProfit}`);
      }
    } catch (error) {
      this.logger.error('Error managing open orders', error);
    }
  }

  private async closePosition(position: any) {
    try {
      await this.connection.closePosition(position.id);
      this.logger.log(`Position ${position.id} closed`);
    } catch (error) {
      this.logger.error(`Error closing position ${position.id}`, error);
    }
  }

  private async cekOrderOpened(connection: any): Promise<boolean> {
    try {
      const openPositions = connection.terminalState.positions;
      return openPositions.length === 0;
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

  private async getSpread(): Promise<number> {
    try {
      const marketData = await this.connection.subscribeToMarketData(this.pair);
      return marketData.ask - marketData.bid;
    } catch (error) {
      this.logger.error('Error fetching market spread', error);
      return 0;
    }
  }

  private scheduleNextFetch() {
    setInterval(async () => {
      await this.analyzeTrend();
    }, 60000); // Eksekusi setiap 1 menit
  }
}
