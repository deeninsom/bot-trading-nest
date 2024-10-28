import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import MetaApi from 'metaapi.cloud-sdk';
import { Repository } from 'typeorm';
import Candles from './app.entity';

@Injectable()
export class TestService implements OnModuleInit {
  private readonly logger = new Logger(TestService.name);
  private token = process.env.TOKEN;
  private accountId = process.env.ACC_ID;
  private pair = 'USDJPY';
  private volume = 0.01;
  private bbPeriod = 20; // Periode untuk Bollinger Bands
  private bbStdDev = 2; // Standar deviasi untuk Bollinger Bands

  constructor(
    @InjectRepository(Candles)
    private pairRepository: Repository<Candles>,
  ) { }

  public async onModuleInit() {
    const { account, metaApi, streamConnection } = await this.initializeMetaApi();
    await this.fetchLastCandleHistories(account);
    const dataCandle = await this.fetchCandleFromDatabase();
    this.checkForTradeOpportunity(dataCandle, streamConnection);
    this.scheduleNextFetch(account, metaApi, streamConnection);
  }

  async initializeMetaApi() {
    const metaApi = new MetaApi(this.token);
    const account = await metaApi.metatraderAccountApi.getAccount(this.accountId);
    const streamConnection = account.getStreamingConnection();
    await streamConnection.connect();

    if (account.state !== 'DEPLOYED') {
      await account.deploy();
    }

    await account.waitConnected();
    return { account, metaApi, streamConnection };
  }

  async fetchLastCandleHistories(account: any) {
    const now = new Date();
    const currentWIBTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const startTime = new Date(currentWIBTime.getFullYear(), currentWIBTime.getMonth(), currentWIBTime.getDate(), currentWIBTime.getHours() - 1);
    const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);
    this.saveHistoryCandles(candles);

    // const startOctober = new Date(currentWIBTime.getFullYear(), 10, 25); // Bulan Oktober
    // const endOctober = new Date(currentWIBTime.getFullYear(), 10, 26) // 1 November

    // const candlesOctober await account.getHistoricalCandles(this.pair, '5m', startOctober, endOctober.getTime(), 0);

    // this.saveHistoryCandles(candlesOctober)

    return candles;
  }

  async saveHistoryCandles(payload: any) {
    if (!payload || payload.length === 0) {
      console.log('Data candle tidak ada');
      return;
    }

    try {
      await Promise.all(
        payload.map(async (value: any) => {
          const existingCandle = await this.pairRepository.findOne({
            where: { time: value.time }
          });

          if (!existingCandle) {
            const candle = this.pairRepository.create({ ...value });
            await this.pairRepository.save(candle);
            console.log(`Candle data for ${value.time} successfully saved`);
          } else {
            console.log(`Candle data for ${value.time} already exists, skipping save.`);
          }
        })
      );
    } catch (error) {
      console.error('Error saving candle data:', error);
    }
  }

  async fetchCandleFromDatabase() {
    try {
      return await this.pairRepository.find({
        order: {
          time: 'ASC'
        }
      });
    } catch (error) {
      console.log(error);
    }
  }

  checkForTradeOpportunity(candles: any[], connection) {
    if (candles.length < this.bbPeriod) {
      console.log('Not enough data to calculate Bollinger Bands.');
      return;
    }

    // Extract closing prices and convert to numbers
    const closingPrices = candles.slice(-this.bbPeriod).map(candle => Number(candle.close));

    // Calculate Middle Band (SMA)
    const middleBand = closingPrices.reduce((sum, price) => sum + price, 0) / this.bbPeriod;

    // Calculate Standard Deviation
    const stdDev = Math.sqrt(closingPrices.reduce((sum, price) => sum + Math.pow(price - middleBand, 2), 0) / this.bbPeriod);

    // Calculate Upper and Lower Bands
    const upperBand = middleBand + (this.bbStdDev * stdDev);
    const lowerBand = middleBand - (this.bbStdDev * stdDev);
    const currentPrice = closingPrices[closingPrices.length - 1];
    
    console.log(`Middle Band: ${middleBand.toFixed(3)}, Upper Band: ${upperBand.toFixed(3)}, Lower Band: ${lowerBand.toFixed(3)}, Current Price: ${currentPrice.toFixed(3)}`);

    // Analyze Trend
    const trend = this.analyzeTrend(candles);
    console.log(`Current trend: ${trend}`);

    // console.log(currentPrice.toFixed(1))
    // Trading Logic
    if (trend === 'uptrend') {
      if (currentPrice.toFixed(3) < lowerBand.toFixed(3)) {
        console.log('In an uptrend. Price is below lower Bollinger Band. Consider buying.');
        this.executeTrade('buy', connection);
      } else {
        console.log('Price is within the Bollinger Bands in an uptrend. No trade opportunity.');
      }
    } else if (trend === 'downtrend') {
      if (currentPrice.toFixed(3) > upperBand.toFixed(3)) {
        console.log('In a downtrend. Price is above upper Bollinger Band. Consider selling.');
        this.executeTrade('sell', connection);
      } else {
        console.log('Price is within the Bollinger Bands in a downtrend. No trade opportunity.');
      }
    } else {
      console.log('Market is sideways. No trade opportunity.');
    }

  }

  analyzeTrend(candles: any[]) {
    const last100Candles = candles.slice(-200);

    const closingPrices = last100Candles.map(candle => Number(candle.close));

    // Hitung pergerakan harga dan ambil rata-rata
    const priceChanges = closingPrices.map((price, index) => index === 0 ? 0 : price - closingPrices[index - 1]);
    const averageChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;

    if (averageChange > 0) {
      return 'uptrend';
    } else if (averageChange < 0) {
      return 'downtrend';
    } else {
      return 'sideways';
    }
  }


  async executeTrade(openMarket: string, connection: any) {
    if (!connection) {
      console.error('Connection is not defined. Cannot execute trade.');
      return;
    }

    let orderResponse;

    try {
      switch (openMarket) {
        case 'buy':
          orderResponse = await connection.createMarketBuyOrder(this.pair, this.volume);
          break;

        case 'sell':
          orderResponse = await connection.createMarketSellOrder(this.pair, this.volume);
          break;

        default:
          console.log('Open market is invalid. Must be "buy" or "sell".');
          return;
      }

      console.log(`Trade executed: ${openMarket} ${this.pair} at volume ${this.volume}`);


      await new Promise(resolve => setTimeout(resolve, 2000));

      const orderHistory = await connection.historyStorage.getHistoryOrdersByPosition(`${orderResponse.positionId}`);

      if (!orderHistory || orderHistory.length === 0) {
        console.error('No order history found. Cannot set TP.');
        return; // Exit if there is no order history
      }

      const executedPrice = orderHistory[0]?.openPrice;
      const orderType = orderHistory[0].type;

      const tp = orderType !== 'ORDER_TYPE_BUY' ? executedPrice - 0.200 : executedPrice + 0.200;
      const sl = orderType !== 'ORDER_TYPE_BUY' ? executedPrice + 0.100 : executedPrice - 0.100;

      await this.setTakeProfit(connection, orderHistory[0]?.id, tp.toFixed(3), sl.toFixed(3));

    } catch (error) {
      console.error('An error occurred while executing the trade:', error);
    }
  }

  async setTakeProfit(connection: any, orderId: any, tp: any, sl: any) {
    try {
      const takeProfit = Number(tp);
      const stopLoss = Number(sl);

      if (isNaN(takeProfit) || isNaN(stopLoss)) {
        console.error('Take Profit or Stop Loss is not a valid number.');
        return; // Keluar jika tidak valid
      }

      console.log(`Order ID: ${orderId}`);
      console.log(`Setting TP: ${takeProfit}, SL: ${stopLoss}`);

      await connection.modifyPosition(orderId, null, takeProfit);
      console.log(`Take Profit for order ${orderId} set to ${takeProfit} and Stop Loss set to ${stopLoss}`);
    } catch (err) {
      console.error('Error setting take profit:', err);
    }
  }

  scheduleNextFetch(account, metaApi, streamConnection) {
    const now: any = new Date();
    // const nextMinute: any = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);
    const nextFiveMinutes: any = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes - now;

    setTimeout(async () => {
      const { account, metaApi, streamConnection } = await this.initializeMetaApi();
      await this.fetchLastCandleHistories(account);
      const dataCandle = await this.fetchCandleFromDatabase();
      this.checkForTradeOpportunity(dataCandle, streamConnection);
      this.scheduleNextFetch(account, metaApi, streamConnection);
    }, timeout);
  }
}
