import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import MetaApi from 'metaapi.cloud-sdk';
import { Repository } from 'typeorm';
import Candles from './app.entity';

@Injectable()
export class TestNewService implements OnModuleInit {
  private readonly logger = new Logger(TestNewService.name);
  private token = process.env.TOKEN;
  private accountId = process.env.ACC_ID;
  private pair = 'USDJPY';
  private volume = 0.01;
  private bbPeriod = 20;
  private bbStdDev = 2;
  private maPeriod = 50; // Period for Moving Average
  private rsiPeriod = 14; // Period for RSI

  constructor(
    @InjectRepository(Candles)
    private pairRepository: Repository<Candles>,
  ) { }

  public async onModuleInit() {
    try {
      const { account, metaApi, streamConnection } = await this.initializeMetaApi();
      await this.fetchLastCandleHistories(account);
      const dataCandle = await this.fetchCandleFromDatabase();
      this.checkForTradeOpportunity(dataCandle, streamConnection);
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
      const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);

      // const startOctober = new Date(currentWIBTime.getFullYear(), 10, 25); // Bulan Oktober
      // const endOctober = new Date(currentWIBTime.getFullYear(), 10, 26) // 1 November

      // const candlesOctober = await account.getHistoricalCandles(this.pair, '5m', startOctober, endOctober.getTime(), 0);

      // this.saveHistoryCandles(candlesOctober)
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

  checkForTradeOpportunity(candles: any[], connection) {
    if (candles.length < this.bbPeriod) {
      this.logger.warn('Not enough data to calculate Bollinger Bands.');
      return;
    }

    const closingPrices = candles.slice(-this.bbPeriod).map(candle => Number(candle.close));
    const middleBand = closingPrices.reduce((sum, price) => sum + price, 0) / this.bbPeriod;
    const stdDev = Math.sqrt(closingPrices.reduce((sum, price) => sum + Math.pow(price - middleBand, 2), 0) / this.bbPeriod);
    const upperBand = middleBand + (this.bbStdDev * stdDev);
    const lowerBand = middleBand - (this.bbStdDev * stdDev);
    const currentPrice = closingPrices[closingPrices.length - 1];

    this.logger.log(`Middle Band: ${middleBand.toFixed(3)}, Upper Band: ${upperBand.toFixed(3)}, Lower Band: ${lowerBand.toFixed(3)}, Current Price: ${currentPrice.toFixed(3)}`);

    const trend = this.analyzeTrend(candles);
    const movingAverage = this.calculateMovingAverage(candles, this.maPeriod);
    const rsi = this.calculateRSI(candles, this.rsiPeriod);

    this.logger.log(`Current trend: ${trend}, Moving Average: ${movingAverage.toFixed(3)}, RSI: ${rsi.toFixed(2)}`);

    // Trading Logic
    this.handleTradeLogic(trend, currentPrice, upperBand, lowerBand, movingAverage, rsi, connection);
  }

  handleTradeLogic(trend: string, currentPrice: number, upperBand: number, lowerBand: number, movingAverage: number, rsi: number, connection: any) {
    if (trend === 'uptrend') {
      if (currentPrice < lowerBand && rsi < 30) {
        this.logger.log('In an uptrend. Price is below lower Bollinger Band and RSI indicates oversold. Consider buying.');
        this.executeTrade('buy', connection);
      } else {
        this.logger.log('Price is within the Bollinger Bands in an uptrend. No trade opportunity.');
      }
    } else if (trend === 'downtrend') {
      if (currentPrice > upperBand && rsi > 70) {
        this.logger.log('In a downtrend. Price is above upper Bollinger Band and RSI indicates overbought. Consider selling.');
        this.executeTrade('sell', connection);
      } else {
        this.logger.log('Price is within the Bollinger Bands in a downtrend. No trade opportunity.');
      }
    } else {
      this.logger.log('Market is sideways. No trade opportunity.');
    }
  }

  analyzeTrend(candles: any[]) {
    const last200Candles = candles.slice(-500);
    const closingPrices = last200Candles.map(candle => Number(candle.close));
    const priceChanges = closingPrices.map((price, index) => index === 0 ? 0 : price - closingPrices[index - 1]);
    const averageChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;

    return averageChange > 0 ? 'uptrend' : averageChange < 0 ? 'downtrend' : 'sideways';
  }

  calculateMovingAverage(candles: any[], period: number) {
    const closingPrices = candles.slice(-period).map(candle => Number(candle.close));
    return closingPrices.reduce((sum, price) => sum + price, 0) / period;
  }

  calculateRSI(candles: any[], period: number) {
    const closingPrices = candles.slice(-period).map(candle => Number(candle.close));
    let gain = 0;
    let loss = 0;

    for (let i = 1; i < closingPrices.length; i++) {
      const change = closingPrices[i] - closingPrices[i - 1];
      if (change > 0) gain += change;
      else loss -= change; // loss is positive in absolute terms
    }

    const averageGain = gain / period;
    const averageLoss = loss / period;

    if (averageLoss === 0) return 100; // avoid division by zero

    const rs = averageGain / averageLoss;
    return 100 - (100 / (1 + rs));
  }

  async executeTrade(openMarket: string, connection: any) {
    if (!connection) {
      this.logger.error('Connection is not defined. Cannot execute trade.');
      return;
    }

    try {
      let orderResponse;

      if (openMarket === 'buy') {
        orderResponse = await connection.createMarketBuyOrder(this.pair, this.volume);
      } else if (openMarket === 'sell') {
        orderResponse = await connection.createMarketSellOrder(this.pair, this.volume);
      } else {
        this.logger.warn('Open market is invalid. Must be "buy" or "sell".');
        return;
      }

      this.logger.log(`Trade executed: ${openMarket} ${this.pair} at volume ${this.volume}`);
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

      const executedPrice = orderHistory[0].openPrice;
      const orderType = orderHistory[0].type;
      const tp = orderType !== 'ORDER_TYPE_BUY' ? executedPrice - 0.080 : executedPrice + 0.080;
      const sl = orderType !== 'ORDER_TYPE_BUY' ? executedPrice + 0.100 : executedPrice - 0.100;

      await connection.modifyPosition(orderHistory[0].id, null, tp);
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
