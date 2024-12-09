import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Candles from './app.entity';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class LstmService implements OnModuleInit {
  private readonly logger = new Logger(LstmService.name);
  private readonly pair = 'USDJPY';
  private token = process.env.TOKEN;
  private accountId = process.env.ACC_ID;
  private connection: any;

  constructor(
    @InjectRepository(Candles)
    private readonly priceRepository: Repository<Candles>,
  ) { }

  async onModuleInit() {
    const { account, streamConnection } = await this.initializeMetaApi();
    this.connection = streamConnection;
    await this.fetchLastCandleHistories(account);
    const db = await this.fetchCandleFromDatabase();
    // await this.analyzePriceActionWithFibonacci(db);
    // this.scheduleNextFetch(account);
  }

  async initializeMetaApi() {
    const metaApi = new MetaApi(this.token);
    const account = await metaApi.metatraderAccountApi.getAccount(this.accountId);
    const streamConnection = account.getStreamingConnection();

    await streamConnection.connect();

    if (account.state !== 'DEPLOYED') {
      await account.deploy();
      this.logger.log('Account deployed.');
    }

    await account.waitConnected();
    this.logger.log('Account connected.');
    return { account, metaApi, streamConnection };
  }

  async fetchLastCandleHistories(account: any) {
    try {
      const now = new Date();
      const currentWIBTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
      // this.saveHistoryCandles(candlesOctober)
      const startTime = new Date(currentWIBTime.getTime() - (60 * 60 * 1000)); // 1 hour ago

      const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);
      await this.saveHistoryCandles(candles);

      return candles;
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

  async fetchCandleFromDatabase() {
    try {
      const now = new Date();
      const startOfToday = new Date(now.setHours(0, 0, 0, 0));
      const endOfToday = new Date(now.setHours(23, 59, 59, 999));

      const yesterday = new Date();
      yesterday.setDate(now.getDate() - 1);
      const startOfYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
      const endOfYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

      return await this.priceRepository.createQueryBuilder('candle')
        .where('candle.time >= :startOfYesterday', { startOfYesterday })
        .andWhere('candle.time <= :endOfToday', { endOfToday })
        .orderBy('candle.time', 'ASC')
        .getMany();
    } catch (error) {
      this.logger.error('Error fetching candle from database', error);
      return [];
    }
  }

  async analyzePriceActionWithFibonacci(candles) {
    try {
      // Ambil data candle terakhir
      // const candles = await this.fetchCandleFromDatabase();

      if (candles.length === 0) {
        this.logger.warn('No candle data available for analysis.');
        return;
      }

      // Ambil harga tertinggi dan terendah
      const highPrice = Math.max(...candles.map(c => c.high));
      const lowPrice = Math.min(...candles.map(c => c.low));

      // Hitung level Fibonacci
      const fibonacciLevels = this.calculateFibonacciLevels(highPrice, lowPrice);

      this.logger.log('Fibonacci Levels Calculated:');
      this.logger.log(`High Price: ${highPrice}`);
      this.logger.log(`Low Price: ${lowPrice}`);
      this.logger.log(`Fibonacci Levels: ${fibonacciLevels.join(', ')}`);

      // Anda bisa menggunakan fibonacciLevels untuk melakukan analisis lebih lanjut
      // Misalnya, melihat apakah harga saat ini mendekati level-level ini untuk pengambilan keputusan

      // Misalnya, menandai level-level tersebut dalam database atau dalam grafik visualisasi
      // Anda bisa menyimpannya atau melaporkan pada sistem untuk pemrosesan lebih lanjut

    } catch (error) {
      this.logger.error('Error analyzing price action with Fibonacci', error);
    }
  }
  
  calculateFibonacciLevels(high: number, low: number): number[] {
    const diff = high - low;

    return [
      high, // 0% retracement (level tertinggi)
      high - 0.236 * diff, // 23.6% level
      high - 0.382 * diff, // 38.2% level
      high - 0.5 * diff,   // 50% level
      high - 0.618 * diff, // 61.8% level
      low, // 100% retracement (level terendah)
    ];
  }


  scheduleNextFetch(account: any) {
    const now = new Date();
    const nextFiveMinutes = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes.getTime() - now.getTime();

    setTimeout(async () => {
      await this.onModuleInit(); // Restart the fetch process
    }, timeout);
  }
}
