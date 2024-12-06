import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Candles from './app.entity';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  private readonly targetTP = 0.080; // Target TP
  private readonly stopLoss = 0.030; // Target Stop Loss
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
    this.cekOrderOpened(streamConnection)
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
        .createQueryBuilder('candle')  // 'candle' adalah alias untuk tabel harga
        .where('candle.time >= :startOfMonth', { startOfMonth })
        .andWhere('candle.time <= :endOfMonth', { endOfMonth })
        .orderBy('candle.time', 'ASC')  // Mengurutkan berdasarkan waktu
        .getMany();  // Mengambil hasil dalam bentuk array

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
      // Fetch the latest candles from the database
      const candles = await this.fetchCandleFromDatabase();
      if (candles.length < 2) {
        this.logger.warn('Not enough candle data for trend analysis.');
        return 'Not enough data';
      }

      // Calculate the 20-period EMA
      const ema20 = await this.calculateEMA(20, candles);

      // Get the latest closing price
      const latestCandle = candles[candles.length - 1];
      const currentPrice = Number(latestCandle.close);
      // await this.openSellPosition();
      // Analyze the trend based on the comparison of price and EMA
      if (currentPrice > ema20) {
        this.logger.log('Uptrend: Current price is above the 20-period EMA');
        return 'UP'; // Uptrend when price > EMA 20
      } else if (currentPrice < ema20) {
        this.logger.log('Downtrend: Current price is below the 20-period EMA');
        return 'DOWN'; // Downtrend when price < EMA 20
      } else {
        this.logger.log('Neutral: Current price equals the 20-period EMA');
        return 'NEUTRAL'; // Neutral when price equals EMA 20
      }
    } catch (error) {
      this.logger.error('Error analyzing trend', error);
      return 'Error';
    }
  }

  async checkPullback(trend: string, ema20: number, currentPrice: number) {
    try {
      // Threshold to consider as a "pullback" to the EMA
      const pullbackThreshold = 0.001; // Adjust this value based on your strategy
      const cekOrder = this.cekOrderOpened

      if (trend === 'UP' && currentPrice < ema20 && Math.abs(currentPrice - ema20) < pullbackThreshold) {
        this.logger.log('Uptrend: Price pulled back to EMA, considering buy...');
        if (cekOrder) {
          await this.openBuyPosition();
        }
      } else if (trend === 'DOWN' && currentPrice > ema20 && Math.abs(currentPrice - ema20) < pullbackThreshold) {
        this.logger.log('Downtrend: Price pulled back to EMA, considering sell...');
        if (cekOrder) {
          await this.openSellPosition();
        }
      }
    } catch (error) {
      this.logger.error('Error checking for pullback', error);
    }
  }

  async openBuyPosition() {
    try {
      const order = await this.connection.createMarketBuyOrder(this.pair, this.volume);
      this.logger.log('Buy position opened:', order);
      await this.setTPandSL(order, 'buy');
    } catch (error) {
      this.logger.error('Error opening buy position', error);
    }
  }

  async openSellPosition() {
    try {
      const order = await this.connection.createMarketSellOrder(this.pair, this.volume);
      this.logger.log('Sell position opened:', order);
      await this.setTPandSL(order, 'sell');
    } catch (error) {
      this.logger.error('Error opening sell position', error);
    }
  }

  async setTPandSL(order: any, type: any) {
    console.log(order)
    try {
      const tpPrice = type === 'sell' ? order.price - this.targetTP : order.price + this.targetTP;
      const slPrice = type === 'sell' ? order.price + this.targetTP : order.price - this.targetTP;
      await this.connection.modifyPosition(order.orderId, slPrice, tpPrice);
      // await this.connection.setStopLoss(order.id, slPrice);
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
      this.cekOrderOpened(streamConnection)
      this.analyzeTrend()
      // Schedule the next fetch operation
      this.scheduleNextFetch(account, streamConnection);
    }, timeout);
  }
}
