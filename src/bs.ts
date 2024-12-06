import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import MetaApi from 'metaapi.cloud-sdk';
import { Repository } from 'typeorm';
import Candles from './app.entity';

@Injectable()
export class BSService implements OnModuleInit {
  private readonly logger = new Logger(BSService.name);
  private token = process.env.TOKEN;
  private accountId = process.env.ACC_ID;
  private pair = 'USDJPY';
  private volume = 0.01;
  private fastPeriod = 8;  // Fast period for EMA
  private mediumPeriod = 21; // Medium period for EMA
  private slowPeriod = 55; // Slow period for EMA

  constructor(
    @InjectRepository(Candles)
    private pairRepository: Repository<Candles>,
  ) {}

  public async onModuleInit() {
    try {
      const { account, metaApi, streamConnection } = await this.initializeMetaApi();
      await this.fetchLastCandleHistories(account);
      const dataCandle = await this.fetchCandleFromDatabase();
      
      // Check for EMA crossover and execute trade
      await this.checkEmaCrossoverAndTrade(dataCandle, streamConnection);

      // Continue fetching candles
      this.scheduleNextFetch(account, metaApi, streamConnection);
    } catch (error) {
      this.logger.error('Error during module initialization', error);
    }
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
      const startTime = new Date(currentWIBTime.getTime() - (60 * 60 * 1000)); // 1 hour ago
      const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 200); // Fetching 200 candles

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
          const existingCandle = await this.pairRepository.findOne({ where: { time: value.time } });
          if (!existingCandle) {
            const candle = this.pairRepository.create({ ...value });
            await this.pairRepository.save(candle);
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
      return await this.pairRepository.find({ order: { time: 'ASC' } });
    } catch (error) {
      this.logger.error('Error fetching candle from database', error);
    }
  }

  // Function to calculate EMA
  calculateEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    let ema = [data[0]];

    for (let i = 1; i < data.length; i++) {
      ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }

    return ema;
  }

  // Check for EMA crossover and trade accordingly
  async checkEmaCrossoverAndTrade(candles: any[], connection: any) {
    const closePrices = candles.map(candle => Number(candle.close)); // Ensure close prices are Numbers

    // Calculate the EMAs
    const fastEma = this.calculateEMA(closePrices, this.fastPeriod);
    const mediumEma = this.calculateEMA(closePrices, this.mediumPeriod);
    const slowEma = this.calculateEMA(closePrices, this.slowPeriod);

    // Get the latest EMA values
    const latestFastEma = Number(fastEma[fastEma.length - 1]);
    const latestMediumEma = Number(mediumEma[mediumEma.length - 1]);
    const latestSlowEma = Number(slowEma[slowEma.length - 1]);

    const prevFastEma = Number(fastEma[fastEma.length - 2]);
    const prevMediumEma = Number(mediumEma[mediumEma.length - 2]);
    const prevSlowEma = Number(slowEma[slowEma.length - 2]);

    // Crossover logic
    if (prevFastEma < prevMediumEma && prevMediumEma < prevSlowEma && latestFastEma > latestMediumEma && latestMediumEma > latestSlowEma) {
      // Fast EMA crossed above Medium and Slow EMAs: BUY signal
      this.logger.log('Buy signal detected!');
      await this.executeTrade('buy', connection);
    } else if (prevFastEma > prevMediumEma && prevMediumEma > prevSlowEma && latestFastEma < latestMediumEma && latestMediumEma < latestSlowEma) {
      // Fast EMA crossed below Medium and Slow EMAs: SELL signal
      this.logger.log('Sell signal detected!');
      await this.executeTrade('sell', connection);
    } else {
      this.logger.log('No crossover detected, holding position.');
    }
  }

  async executeTrade(signal: string, connection: any) {
    if (!connection) {
      this.logger.error('Connection is not defined. Cannot execute trade.');
      return;
    }

    try {
      let orderResponse;

      if (signal === 'buy') {
        orderResponse = await connection.createMarketBuyOrder(this.pair, this.volume);
      } else if (signal === 'sell') {
        orderResponse = await connection.createMarketSellOrder(this.pair, this.volume);
      } else {
        this.logger.warn('Signal is HOLD. No trade executed.');
        return;
      }

      this.logger.log(`Trade executed: ${signal} ${this.pair} at volume ${this.volume}`);
      await this.setTakeProfit(connection, orderResponse.positionId);
    } catch (error) {
      this.logger.error('An error occurred while executing the trade:', error);
    }
  }

  async setTakeProfit(connection: any, positionId: string) {
    try {
      const orderHistory = await connection.historyStorage.getHistoryOrdersByPosition(positionId);

      if (!orderHistory || orderHistory.length === 0) {
        this.logger.error('No order history found. Cannot set TP.');
        return;
      }

      const executedPrice = Number(orderHistory[0].openPrice); // Ensure executed price is a Number
      const orderType = orderHistory[0].type;
      const tp = orderType !== 'ORDER_TYPE_BUY' ? (executedPrice - 0.080) : (executedPrice + 0.080); // Set TP with adjusted price
      const sl = orderType !== 'ORDER_TYPE_BUY' ? (executedPrice + 0.030) : (executedPrice - 0.030); // Set SL with adjusted price

      await connection.modifyPosition(orderHistory[0].id, null, Number(tp.toFixed(3))); // Ensure TP is rounded to 3 decimal places
      await connection.modifyPosition(orderHistory[0].id, null, Number(sl.toFixed(3))); // Ensure SL is rounded to 3 decimal places

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
