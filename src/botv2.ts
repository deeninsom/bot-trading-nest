import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Candles from './app.entity';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotV2Service implements OnModuleInit {
  private accountId = process.env.ACC_ID;
  private readonly logger = new Logger(BotV2Service.name);
  private api = new MetaApi(process.env.TOKEN);
  private connection = null;
  private account = null;
  private pair = 'USDJPY';
  private volume = 0.01
  private takeProfit = 0.190;
  private stopLoss = 0.100;
  constructor(
    @InjectRepository(Candles)
    private readonly priceRepository: Repository<Candles>,
  ) { }

  async onModuleInit() {
    // step 1
    await this.initializeMetaApi();

    // step 2
    await this.fetchLastCandleHistories();

    // step 3
    this.analyzeTrend()

    this.scheduleNextFetch();
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

  async fetchLastCandleHistories() {
    try {
      const now = new Date();
      const currentWIBTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
      const startTime = new Date(currentWIBTime.getTime() - (60 * 60 * 1000)); // 1 hour ago
      const candles = await this.account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);
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
        .where('candle.time >= :startOfMonth', { startOfMonth })
        .andWhere('candle.time <= :endOfMonth', { endOfMonth })
        .orderBy('candle.time', 'ASC')
        .getMany();

      return candles;
    } catch (error) {
      console.log(error);
      return [];  // Mengembalikan array kosong jika terjadi error
    }
  }

  async analyzeTrend(): Promise<string> {
    try {
      const candles = await this.fetchCandleFromDatabase();
      if (candles.length < 2) {
        this.logger.warn('Data candle tidak cukup untuk analisis tren.');
        return 'Not enough data';
      }

      // Menghitung EMA50, EMA200, dan EMA20
      const ema50 = await this.calculateEMA(50, candles);
      const ema200 = await this.calculateEMA(200, candles);
      const ema20 = await this.calculateEMA(20, candles);

      const latestCandle = candles[candles.length - 1];
      const currentPrice = Number(latestCandle.close);

      let trend = 'NEUTRAL';

      // Analisis tren berdasarkan EMA50 dan EMA200
      if (currentPrice > ema50 && currentPrice > ema200) {
        trend = 'UP';  // Tren naik jika harga di atas EMA50 dan EMA200
        this.logger.log(`Uptrend: Harga saat ini di atas EMA50 (${ema50.toFixed(3)}) dan EMA200 (${ema200.toFixed(3)})`);
      } else if (currentPrice < ema50 && currentPrice < ema200) {
        trend = 'DOWN';  // Tren turun jika harga di bawah EMA50 dan EMA200
        this.logger.log(`Downtrend: Harga saat ini di bawah EMA50 (${ema50.toFixed(3)}) dan EMA200 (${ema200.toFixed(3)})`);
      } else {
        trend = 'NEUTRAL';  // Tren netral jika harga di antara EMA50 dan EMA200
        this.logger.log(`Neutral: Harga saat ini antara EMA50 (${ema50.toFixed(3)}) dan EMA200 (${ema200.toFixed(3)})`);
      }

      const subscribeMarket = await this.connection.subscribeToMarketData('USDJPY')
      const spread = subscribeMarket.ask - subscribeMarket.bid
      await this.checkPullback(trend, ema50, ema20, trend === 'UP' ? subscribeMarket.ask : subscribeMarket.bid, ema200, spread.toFixed(3));

      return trend;
    } catch (error) {
      this.logger.error('Error saat menganalisis tren', error);
      return 'Error';
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

  async checkPullback(trend: string, ema50: any, ema20: any, currentPrice: any, ema200: any, spread: any) {
    try {
      const pullbackThreshold = 0.015; // Ambang batas untuk pullback
      const price = parseFloat(currentPrice.toFixed(3));
      const ema50Value = parseFloat(ema50.toFixed(3));
      const ema20Value = parseFloat(ema20.toFixed(3));
      const ema200Value = parseFloat(ema200.toFixed(3));

      const isApproachingEMA20 = Math.abs(price - ema20Value) < pullbackThreshold;

      if (isApproachingEMA20) {
        this.logger.log(`Harga mendekati EMA20: Harga saat ini ${price}, EMA20 ${ema20Value}`);
      }

      // Menyaring harga mendekati EMA dengan benar
      if (trend === 'UP' && price > ema50Value && price > ema200Value) {
        // Jika harga masih di atas EMA50 dan EMA200 (masih dalam tren naik)
        if (isApproachingEMA20) {
          this.logger.log('Uptrend: Harga kembali ke EMA20, mempertimbangkan buy...');
          const cekOrder = await this.cekOrderOpened(this.connection);
          if (cekOrder) {
            await this.openBuyPosition(price, spread);
          }
        }
      } else if (trend === 'DOWN' && price < ema50Value && price < ema200Value) {
        // Jika harga di bawah EMA50 dan EMA200 (masih dalam tren turun)
        if (isApproachingEMA20) {
          this.logger.log('Downtrend: Harga kembali ke EMA20, mempertimbangkan sell...');
          const cekOrder = await this.cekOrderOpened(this.connection);
          if (cekOrder) {
            await this.openSellPosition(price, spread);
          }
        }
      } else {
        this.logger.log('Tidak ada aksi yang diambil karena harga tidak mendekati EMA atau tren tidak sesuai.');
      }
    } catch (error) {
      this.logger.error('Error saat memeriksa pullback', error);
    }
  }

  async cekOrderOpened(connection: any) {
    const conectStatus = connection.terminalState;
    return conectStatus.positions.length >= 3 ? false : true
  }

  async openBuyPosition(currentPrice: any, spread: any) {
    try {
      const price: number = Number(currentPrice)
      const targetTp = (price + this.takeProfit) + Number(spread); // TP untuk posisi Buy
      const targetLoss = (price - this.stopLoss) - Number(spread); // SL untuk posisi Buy

      const order = await this.connection.createMarketBuyOrder('USDJPY', this.volume, targetLoss, targetTp, {
        comment: 'comment'
      })
      this.logger.log('Buy position opened:', order);
    } catch (error) {
      this.logger.error('Error opening buy position', error);
    }
  }

  async openSellPosition(currentPrice: any, spread: any) {
    try {
      const price: number = Number(currentPrice)
      const targetTp = (price - this.takeProfit) - Number(spread)
      const targetLoss = (price + this.stopLoss) + Number(spread)
      
      const order = await this.connection.createMarketSellOrder('USDJPY', this.volume, targetLoss, targetTp, {
        comment: 'comment'
      })
      this.logger.log('Sell position opened:', order);
    } catch (error) {
      this.logger.error('Error opening sell position', error);
    }
  }

  scheduleNextFetch() {
    const now = new Date();
    const nextFiveMinutes = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes.getTime() - now.getTime();

    setTimeout(async () => {
      // 1
      await this.fetchLastCandleHistories();
      
      // 2
      this.analyzeTrend()

      // 3
      this.scheduleNextFetch();
    }, timeout);
  }
}