import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Candles from './app.entity';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  private readonly targetTP = 0.120; // Target TP
  private readonly stopLoss = 0.070; // Target Stop Loss
  private volume = 0.01;
  private pair = 'USDJPY';
  private token = process.env.TOKEN;
  private accountId = process.env.ACC_ID;
  private connection: any;

  constructor(
    @InjectRepository(Candles)
    private readonly priceRepository: Repository<Candles>,
  ) { }

  async onModuleInit() {
    // Initialize MetaApi and connection only once
    const { account, metaApi, streamConnection } = await this.initializeMetaApi();
    this.connection = streamConnection;

    // Fetch the last candle history once
    await this.fetchLastCandleHistories(account);
    // this.cekOrderOpened(streamConnection)
    this.analyzeTrend()
    // Schedule the next fetch operation
    this.scheduleNextFetch(account, streamConnection);
  }

  async initializeMetaApi() {
    const metaApi = new MetaApi(this.token);
    const account = await metaApi.metatraderAccountApi.getAccount(this.accountId);
    const streamConnection = account.getStreamingConnection();
    await streamConnection.connect();
    await streamConnection.waitSynchronized();
    if (account.state !== 'DEPLOYED') {
      await account.deploy();
      this.logger.log('Account deployed.');
    }

    // await account.waitConnected();
    this.logger.log('Account connected.');
    return { account, metaApi, streamConnection };
  }

  async fetchLastCandleHistories(account: any) {
    try {
      const now = new Date();
      const currentWIBTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
      const startTime = new Date(currentWIBTime.getTime() - (60 * 60 * 1000)); // 1 hour ago
      const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);
      await this.saveHistoryCandles(candles);
    } catch (error) {
      this.logger.error('Error fetching candle histories', error);
    }
  }

  async saveHistoryCandles(payload: any) {
    if (!payload || payload.length === 0) {
      this.logger.warn('No candle data available to save.');
      return;
    }

    try {
      await Promise.all(
        payload.map(async (value: any) => {
          const existingCandle = await this.priceRepository.findOne({ where: { time: value.time } });
          if (!existingCandle) {
            const candle = this.priceRepository.create({ ...value });
            await this.priceRepository.save(candle);
            this.logger.log(`Candle data for ${value.time} successfully saved.`);
          } else {
            this.logger.log(`Candle data for ${value.time} already exists, skipping save.`);
          }
        })
      );
    } catch (error) {
      this.logger.error('Error saving candle data', error);
    }
  }

  async cekOrderOpened(connection: any) {
    const conectStatus = connection.terminalState;
    return conectStatus.positions.length >= 3 ? false : true
  }

  // async fetchCandleFromDatabase() {
  //   try {
  //     return await this.priceRepository.find({
  //       order: {
  //         time: 'ASC'
  //       }
  //     })
  //   } catch (error) {
  //     console.log(error)
  //   }
  // }


  async fetchCandleFromDatabase() {
    try {
      const now = new Date();

      // Mendapatkan awal bulan ini (tanggal 1 di bulan ini)
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Mendapatkan akhir bulan ini (tanggal terakhir di bulan ini)
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      // Menggunakan query builder untuk mencari data candle dalam rentang waktu bulan ini
      const candles = await this.priceRepository
        .createQueryBuilder('candle') 
        // .where('candle.time >= :startOfMonth', { startOfMonth })
        // .andWhere('candle.time <= :endOfMonth', { endOfMonth })
        .orderBy('candle.time', 'ASC') 
        .getMany();  

      return candles;
    } catch (error) {
      console.log(error);
      return [];  // Mengembalikan array kosong jika terjadi error
    }
  }

  async calculateEMA(period: number, candles: any): Promise<number> {
    try {
      // Check if we have enough candles
      if (candles.length < period) {
        this.logger.warn(`Not enough data to calculate ${period}-period EMA.`);
        return 0; // Return 0 if not enough data is available
      }

      const alpha = 2 / (period + 1);  // Smoothing factor
      let ema = Number(candles[0].close);  // Start with the first closing price

      // Apply the formula for EMA
      for (let i = 1; i < candles.length; i++) {
        ema = (Number(candles[i].close) * alpha) + (ema * (1 - alpha));
      }

      return ema;
    } catch (error) {
      this.logger.error(`Error calculating ${period}-period EMA`, error);
      return 0;
    }
  }



  async analyzeTrend(): Promise<string> {
    try {
      const candles = await this.fetchCandleFromDatabase();
      if (candles.length < 2) {
        this.logger.warn('Data candle tidak cukup untuk analisis tren.');
        return 'Not enough data';
      }

      const ema50 = await this.calculateEMA(50, candles);
      const ema20 = await this.calculateEMA(20, candles);

      const latestCandle = candles[candles.length - 1];
      const currentPrice = Number(latestCandle.close);

      let trend = 'NEUTRAL';
      if (currentPrice > ema50) {
        this.logger.log(`Uptrend: Harga saat ini di atas EMA50 (${ema50.toFixed(3)})`);
        trend = 'UP';
      } else if (currentPrice < ema50) {
        this.logger.log(`Downtrend: Harga saat ini di bawah EMA50 (${ema50.toFixed(3)})`);
        trend = 'DOWN';
      } else {
        this.logger.log(`Neutral: Harga saat ini sama dengan EMA50 (${ema50.toFixed(3)})`);
      }

      await this.checkPullback(trend, ema50, ema20, currentPrice);

      return trend;
    } catch (error) {
      this.logger.error('Error saat menganalisis tren', error);
      return 'Error';
    }
  }
  

  async checkPullback(trend: string, ema50: any, ema20: any, currentPrice: any) {
    try {
      const pullbackThreshold = 0.015; // Ambang batas untuk pullback
      const price = parseFloat(currentPrice.toFixed(3));
      const ema50Value = parseFloat(ema50.toFixed(3));
      const ema20Value = parseFloat(ema20.toFixed(3));

      const isApproachingEMA = Number(Math.abs(price - ema20Value).toFixed(3)) < pullbackThreshold;

      if (isApproachingEMA) {
        this.logger.log(`Harga mendekati EMA20: Harga saat ini ${price}, EMA20 ${ema20Value}`);
      }

      // Menyaring harga mendekati EMA dengan benar
      if (trend === 'UP' && price > ema50Value) {
        if (isApproachingEMA) {
          this.logger.log('Uptrend: Harga kembali ke EMA20, mempertimbangkan buy...');
          const cekOrder = await this.cekOrderOpened(this.connection);
          if (cekOrder) {
            await this.openBuyPosition(price);
          }
        }
      } else if (trend === 'DOWN' && price < ema50Value) {
        if (isApproachingEMA) {
          this.logger.log('Downtrend: Harga kembali ke EMA20, mempertimbangkan sell...');
          const cekOrder = await this.cekOrderOpened(this.connection);
          if (cekOrder) {
            await this.openSellPosition(price);
          }
        }
      } else {
        this.logger.log('Tidak ada aksi yang diambil karena harga tidak mendekati EMA atau tren tidak sesuai.');
      }
    } catch (error) {
      this.logger.error('Error saat memeriksa pullback', error);
    }
  }

  async openBuyPosition(currentPrice: any) {
    try {
      const order = await this.connection.createMarketBuyOrder(this.pair, this.volume);
      this.logger.log('Buy position opened:', order);
      await this.setTPandSL(order, 'buy', currentPrice);
    } catch (error) {
      this.logger.error('Error opening buy position', error);
    }
  }

  async openSellPosition(currentPrice: any) {
    try {
      const order = await this.connection.createMarketSellOrder(this.pair, this.volume);
      this.logger.log('Sell position opened:', order);
      await this.setTPandSL(order, 'sell', currentPrice);
    } catch (error) {
      this.logger.error('Error opening sell position', error);
    }
  }

  async setTPandSL(order: any, type: any, currentPrice: any) {
    try {
      const price : any= Number(currentPrice)

      const tpPrice = type === 'sell' ? price - this.targetTP : price + this.targetTP;
      const slPrice = type === 'sell' ? price + this.stopLoss : price - this.stopLoss;
      
      console.log(order.orderId, slPrice.toFixed(3), tpPrice.toFixed(3), price)
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.connection.modifyPosition(order.orderId, slPrice, tpPrice);
      this.logger.log('Take profit and stop loss set.');
    } catch (error) {
      this.logger.error('Error setting TP/SL', error);
    }
  }

  scheduleNextFetch(account: any, streamConnection: any) {
    const now = new Date();
    const nextFiveMinutes = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes.getTime() - now.getTime();

    setTimeout(async () => {
      // Fetch the last candle histories periodically (every 5 minutes)
      await this.fetchLastCandleHistories(account);
      // this.cekOrderOpened(streamConnection)
      this.analyzeTrend()
      // Schedule the next fetch operation
      this.scheduleNextFetch(account, streamConnection);
    }, timeout);
  }
}
