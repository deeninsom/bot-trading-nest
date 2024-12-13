import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotV3Service implements OnModuleInit {
  private accountId = process.env.ACC_ID;
  private readonly logger = new Logger(BotV3Service.name);
  private api = new MetaApi(process.env.TOKEN);
  private connection = null;
  private account = null;
  private pair = 'USDJPY';
  private volume = 0.01;
  private takeProfit = 0.190;
  private stopLoss = 0.090;

  // Variable untuk menyimpan harga sebelumnya
  private lastPrice: number | null = null;

  constructor() {}

  async onModuleInit() {
    await this.initializeMetaApi();
    this.scheduleNextFetch(); // Schedule next fetch after initialization
  }

  async initializeMetaApi() {
    try {
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);
      this.logger.log('Deploying account');
      await this.account.deploy();

      this.logger.log('Waiting for API server to connect to broker (may take a couple of minutes)');
      await this.account.waitConnected();

      this.connection = this.account.getStreamingConnection();
      this.logger.log('Waiting for SDK to synchronize to terminal state (may take some time depending on your history size)');
      await this.connection.connect();
      await this.connection.waitSynchronized();

      this.logger.log('Connected and synchronized');
    } catch (error) {
      this.logger.error('Error during MetaApi connection', error);
    }
  }

  async fetchRealTimePrice() {
    try {
      const subscribeMarket = await this.connection.subscribeToMarketData(this.pair);
      return subscribeMarket.ask; // Returning ask price
    } catch (error) {
      this.logger.error('Error fetching real-time price', error);
      return null;
    }
  }

  async analyzeTrend() {
    try {
      const price = await this.fetchRealTimePrice();
      if (price === null) {
        this.logger.warn('No price data available');
        return;
      }

      // Menentukan tren berdasarkan perbandingan harga saat ini dengan harga sebelumnya
      let trend = 'NEUTRAL';
      if (this.lastPrice !== null) {
        if (price > this.lastPrice) {
          trend = 'UP';
          this.logger.log(`Price is increasing, trend is UP.`);
        } else if (price < this.lastPrice) {
          trend = 'DOWN';
          this.logger.log(`Price is decreasing, trend is DOWN.`);
        } else {
          trend = 'NEUTRAL';
          this.logger.log(`Price is stable, trend is NEUTRAL.`);
        }
      }

      // Menyimpan harga saat ini untuk digunakan pada perbandingan berikutnya
      this.lastPrice = price;

      // Mendapatkan menit lokal
      const currentMinute = new Date().getMinutes();

      // Menentukan apakah saat ini kelipatan dari 5 menit
      if (currentMinute % 5 === 0) {
        // Mengecek apakah ada kurang dari 2 order terbuka sebelum membuka posisi
        const canOpenOrder = await this.cekOrderOpened(this.connection);
        if (canOpenOrder) {
          // Membuka posisi hanya pada menit kelipatan 5
          await this.openPositionBasedOnTrend(trend, price);
        } else {
          this.logger.log('There are already 2 orders open. Not opening new position.');
        }
      } else {
        this.logger.log(`Current time is ${currentMinute} minutes, no action taken (waiting for 5-minute mark).`);
      }

    } catch (error) {
      this.logger.error('Error while analyzing the trend', error);
    }
  }

  async openPositionBasedOnTrend(trend: string, currentPrice: number) {
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

  async getSpread(): Promise<number> {
    try {
      const subscribeMarket = await this.connection.subscribeToMarketData(this.pair);
      return subscribeMarket.ask - subscribeMarket.bid;
    } catch (error) {
      this.logger.error('Error fetching market spread', error);
      return 0;
    }
  }

  async openBuyPosition(currentPrice: number, spread: number) {
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

  async openSellPosition(currentPrice: number, spread: number) {
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

  // Fungsi untuk mengecek apakah jumlah order terbuka sudah lebih dari 2
  async cekOrderOpened(connection: any) {
    try {
      const terminalState = connection.terminalState;
      const openPositions = terminalState.positions; // List of open positions
      return openPositions.length < 2; // Returns true if less than 2 positions are open
    } catch (error) {
      this.logger.error('Error checking open orders', error);
      return false;
    }
  }

  scheduleNextFetch() {
    setInterval(async () => {
      // Setiap menit cek trend dan jika waktunya kelipatan 5 menit, buka posisi
      await this.analyzeTrend();
    }, 60000); // Eksekusi setiap 60000 ms (1 menit)
  }
}
