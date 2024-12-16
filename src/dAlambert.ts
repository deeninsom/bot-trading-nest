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
  private baseVolume = 0.01; // Volume dasar
  private volume = this.baseVolume; // Volume yang akan digunakan dalam trading

  private lastAction: 'BUY' | 'SELL' | null = null; // Menyimpan tindakan terakhir
  private lastEntryTime: number | null = null;
  private highestProfit: number = 0; // Menyimpan profit tertinggi
  private lastTradeProfit: number = 0; // Menyimpan profit transaksi terakhir
  private lastIdOrder: number = 0;
  private lastOrderResult: 'WIN' | 'LOSE' | null = null; // Hasil dari order terakhir

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

  private async getLastTwoCandles() {
    try {
      const candles = await this.account.getHistoricalCandles(this.pair, '5m');
      if (candles.length >= 2) {
        return candles.slice(-2); // Ambil 2 candle terakhir
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
      if (lastTwoCandles && lastTwoCandles.length === 2) {
        const [previousCandle, currentCandle] = lastTwoCandles;

        const canOpenOrder = await this.cekOrderOpened(this.connection);

        // Hanya buka posisi jika tidak ada posisi terbuka dan bisa melakukan entry baru
        if (canOpenOrder && await this.canEnterNewPosition()) {
          const trendIsUp = await this.isUptrend();
          const trendIsDown = await this.isDowntrend();

          if (trendIsUp) {
            await this.openPosition(price); // Jika tren naik, buka posisi BUY
          } else if (trendIsDown) {
            await this.openPosition(price); // Jika tren turun, buka posisi SELL
          } else {
            this.logger.log('No clear trend based on last two candles');
          }
        } else {
          await this.manageOpenOrders();
        }
      }
    } catch (error) {
      this.logger.error('Error analyzing trend', error);
    }
  }

  private async openPosition(currentPrice: number) {
    try {
      const trendIsUp = await this.isUptrend();
      const trendIsDown = await this.isDowntrend();

      if (trendIsUp) {
        await this.openBuyPosition();
      } else if (trendIsDown ) {
        await this.openSellPosition();
      } else {
        this.logger.log('No clear trend to open new position');
      }

      this.highestProfit = 0; // Reset profit tertinggi saat posisi baru dibuka
    } catch (error) {
      this.logger.error('Error opening position', error);
    }
  }

  private async openBuyPosition() {
    try {
      const order = await this.connection.createMarketBuyOrder(this.pair, this.volume);
      this.lastIdOrder = order.positionId;
      this.logger.log('Buy position opened:', order);
    } catch (error) {
      this.logger.error('Error opening buy position', error);
    }
  }

  private async openSellPosition() {
    try {
      const order = await this.connection.createMarketSellOrder(this.pair, this.volume);
      this.lastIdOrder = order.positionId;
      this.logger.log('Sell position opened:', order);
    } catch (error) {
      this.logger.error('Error opening sell position', error);
    }
  }

  private async manageOpenOrders() {
    try {
      const openPositions = this.connection.terminalState.positions;
      let totalProfit = 0;

      for (const position of openPositions) {
        totalProfit += position.unrealizedProfit;

        // Simpan profit tertinggi
        if (position.unrealizedProfit > this.highestProfit) {
          this.highestProfit = position.unrealizedProfit;
        }

        // Tutup posisi jika profit mencapai limit kerugian
        if (position.unrealizedProfit <= -1.00) {
          await this.closePosition(position);
          this.logger.log(`Position closed due to loss. Highest: ${this.highestProfit}, Current: ${position.unrealizedProfit}`);
        }
      }

      // Tutup semua posisi jika total profit mencapai atau melebihi $1
      if (totalProfit >= 1.00) {
        for (const position of openPositions) {
          await this.closePosition(position);
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
      if (position.unrealizedProfit <= -1.00) {
        this.volume = this.volume * 2
      }else{
        this.volume = this.baseVolume
      }
      this.logger.log(`Position ${position.id} closed`);
    } catch (error) {
      this.logger.error(`Error closing position ${position.id}`, error);
    }
  }

  private async cekOrderOpened(connection: any): Promise<boolean> {
    try {
      const openPositions = this.connection.terminalState.positions;
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

  private async isUptrend(): Promise<boolean> {
    const lastTwoCandles = await this.getLastTwoCandles();
    if (!lastTwoCandles || lastTwoCandles.length < 2) {
      return false;
    }

    const [previousCandle, currentCandle] = lastTwoCandles;
    return currentCandle.close > previousCandle.close;
  }

  private async isDowntrend(): Promise<boolean> {
    const lastTwoCandles = await this.getLastTwoCandles();
    if (!lastTwoCandles || lastTwoCandles.length < 2) {
      return false;
    }

    const [previousCandle, currentCandle] = lastTwoCandles;
    return currentCandle.close < previousCandle.close;
  }

  // private async updateVolumeBasedOnLastOrder() {
  //   const history = await this.connection.historyStorage
  //   const state =await this.connection.terminalState
  //   const lastOrder = history.deals
  //   .filter((f) => f.symbol === sys)
  //   if (this.lastOrderResult === 'LOSE') {
  //     this.volume = this.volume * 2; // Gandakan volume jika kalah
  //     this.logger.log(`Volume updated to: ${this.volume}`);
  //   } else if (this.lastOrderResult === 'WIN') {
  //     this.volume = this.baseVolume; // Kembalikan volume ke volume dasar jika menang
  //     this.logger.log(`Volume reset to base volume: ${this.volume}`);
  //   }
  // }

  private scheduleNextFetch() {
    setInterval(async () => {
      await this.analyzeTrend();
    }, 3000); // Eksekusi setiap 3 detik
  }
}
