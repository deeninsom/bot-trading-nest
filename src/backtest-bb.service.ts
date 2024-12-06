import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import Candles from './app.entity';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BacktestService implements OnModuleInit {
  private readonly logger = new Logger(BacktestService.name);
  private readonly startDate = new Date('2024-10-30');
  private readonly endDate = new Date('2024-10-31');
  private readonly targetTP = 0.080; // Target TP
  private readonly stopLoss = 0.030; // Target Stop Loss
  private readonly bollingerPeriod = 5; // Periode Bollinger Bands untuk scalping
  private readonly stdDevMultiplier = 2; // Meningkatkan multiplier untuk scalping
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
    const { account, metaApi, streamConnection } = await this.initializeMetaApi();
    this.connection = streamConnection;
    await this.fetchLastCandleHistories(account);
    // await this.fetchAndIdentifyTrend();
    this.scheduleNextFetch(account, metaApi, streamConnection);
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
      // const startTime = new Date(currentWIBTime.getTime() - (60 * 60 * 1000)); // 1 hour ago
      // const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);

      const startOctober = new Date(currentWIBTime.getFullYear(), 12, 1); // Bulan Oktober
      const endOctober = new Date(currentWIBTime.getFullYear(), 12, 6) // 1 November

      const candlesOctober = await account.getHistoricalCandles(this.pair, '5m', startOctober, endOctober.getTime(), 0);

      this.saveHistoryCandles(candlesOctober)

      // await this.saveHistoryCandles(candles);
      return {};
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

  async fetchAndIdentifyTrend(): Promise<void> {
    const prices = await this.priceRepository.find({
      where: {
        time: Between(this.startDate, this.endDate),
      },
      order: { time: 'ASC' },
    });

    if (prices.length < 10) {
      this.logger.warn("Data tidak cukup untuk mengidentifikasi tren dengan valid.");
      return;
    }

    const trendSignal = this.identifyTrendWithIndicators(prices);
    this.logger.log(`Trend identified: ${trendSignal}`);
  }

  private calculateBollingerBands(prices: number[]): { upperBand: number, lowerBand: number, middleBand: number } | null {
    if (prices.length < this.bollingerPeriod) return null;

    const slice = prices.slice(-this.bollingerPeriod);
    const sum = slice.reduce((a, b) => a + b, 0);
    const mean = sum / this.bollingerPeriod;

    const squaredDiffs = slice.map(price => Math.pow(price - mean, 2));
    const stdDev = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / this.bollingerPeriod);

    const upperBand = mean + (this.stdDevMultiplier * stdDev);
    const lowerBand = mean - (this.stdDevMultiplier * stdDev);

    return { upperBand, lowerBand, middleBand: mean };
  }

  private identifyTrendWithIndicators(prices: Candles[]): string {
    const closePrices = prices.map(price => Number(price.close));
    const bands = this.calculateBollingerBands(closePrices);

    if (!bands) return "Stagnant";

    const latestPrice = closePrices[closePrices.length - 1];

    // Untuk scalping, kita bisa langsung mengambil posisi berdasarkan penembusan
    if (latestPrice > bands.upperBand) {
      this.executeTrade('sell');
      return "Potensi overbought: Sell";
    } else if (latestPrice < bands.lowerBand) {
      this.executeTrade('buy');
      return "Potensi oversold: Buy";
    } else {
      return "Stagnant";
    }
  }

  async executeTrade(openMarket: string) {
    if (!this.connection) {
      this.logger.error('Connection is not defined. Cannot execute trade.');
      return;
    }

    try {
      let orderResponse;

      if (openMarket === 'buy') {
        orderResponse = await this.connection.createMarketBuyOrder(this.pair, this.volume);
      } else if (openMarket === 'sell') {
        orderResponse = await this.connection.createMarketSellOrder(this.pair, this.volume);
      } else {
        this.logger.warn('Open market is invalid. Must be "buy" or "sell".');
        return;
      }

      this.logger.log(`Trade executed: ${openMarket} ${this.pair} at volume ${this.volume}`);

      // Tambahkan delay sebelum mengatur TP
      await new Promise(resolve => setTimeout(resolve, 1000)); // Tunggu 1 detik

      // Cek apakah orderResponse ada dan memiliki positionId
      if (orderResponse && orderResponse.positionId) {
        await this.setTakeProfit(this.connection, orderResponse.positionId);
        orderResponse = null; // Clear orderResponse setelah mengatur TP
      } else {
        this.logger.error('Order response does not contain positionId.');
      }
    } catch (error) {
      this.logger.error('An error occurred while executing the trade:', error);
    }
  }

  async setTakeProfit(connection: any, positionId: string) {
    try {
      // Beri waktu agar riwayat order tersedia
      await new Promise(resolve => setTimeout(resolve, 2000)); // Tunggu 2 detik

      const orderHistory = await connection.historyStorage.getHistoryOrdersByPosition(positionId);

      if (!orderHistory || orderHistory.length === 0) {
        this.logger.error('No order history found. Cannot set TP.');
        return;
      }

      const executedPrice = orderHistory[0].openPrice;
      const orderType = orderHistory[0].type;
      const tp = orderType !== 'ORDER_TYPE_BUY' ? executedPrice - this.targetTP : executedPrice + this.targetTP;
      const sl = orderType !== 'ORDER_TYPE_BUY' ? executedPrice + this.stopLoss : executedPrice - this.stopLoss;

      await connection.modifyPosition(orderHistory[0].id, sl, tp);
      this.logger.log(`Take Profit for order ${orderHistory[0].id} set to ${tp.toFixed(3)} and Stop Loss set to ${sl.toFixed(3)}`);
    } catch (err) {
      this.logger.error('Error setting take profit:', err);
    }
  }

  scheduleNextFetch(account: any, metaApi: any, streamConnection: any) {
    const now = new Date();
    const nextFiveMinutes = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes.getTime() - now.getTime();

    setTimeout(async () => {
      await this.onModuleInit(); // Restart the fetch process
    }, timeout);
  }
}
