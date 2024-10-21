import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import MetaApi, { MetatraderAccount } from 'metaapi.cloud-sdk';
import { Repository } from 'typeorm';
import Candles from './app.entity';

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);
  private token = process.env.TOKEN
  private accountId = process.env.ACC_ID
  private pair = 'USDJPY'
  private volume = 0.01

  constructor(
    @InjectRepository(Candles)
    private pairRepository: Repository<Candles>,
  ) { }

  public async onModuleInit() {
    const { account, metaApi, streamConnection } = await this.initializeMetaApi()
    await this.fetchLastCandleHistories(account)
    const dataCandle = await this.fetchCandleFromDatabase()
    this.calculateRSI(dataCandle, 14, streamConnection);
    this.scheduleNextFetch(account, metaApi, streamConnection)

  }

  async initializeMetaApi() {
    const metaApi = new MetaApi(this.token)
    const account = await metaApi.metatraderAccountApi.getAccount(this.accountId)
    const streamConnection = account.getStreamingConnection()
    await streamConnection.connect()

    if (account.state !== 'DEPLOYED') {
      await account.deploy();
    }

    await account.waitConnected();
    // streamConnection.historyStorage.historyOrders.map((value) => {
    //   const orderHistory = streamConnection.historyStorage.getHistoryOrdersByPosition(`${value.positionId}`);
    //   console.log(orderHistory)
    // })


    return { account, metaApi, streamConnection }
  }

  async fetchLastCandleHistories(account: any) {
    const now = new Date();
    const currentWIBTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const startTime = new Date(currentWIBTime.getFullYear(), currentWIBTime.getMonth(), currentWIBTime.getDate(), currentWIBTime.getHours() - 1);
    const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);
    this.saveHistoryCandles(candles)

    // Mendapatkan data untuk bulan Oktober
    // const startOctober = new Date(currentWIBTime.getFullYear(), 9, 12); // Bulan Oktober
    // const endOctober = new Date(currentWIBTime.getFullYear(), 10, 12); // 1 November

    // const candlesOctober = await account.getHistoricalCandles(this.pair, '5m', startOctober, endOctober.getTime(), 0);

    // this.saveHistoryCandles(candlesOctober)
    return candles
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
      })
    } catch (error) {
      console.log(error)
    }
  }

  calculateRSI(candles: any[], period: number, connection): number | null {
    if (candles.length < period) {
      console.log('Not enough data to calculate RSI');
      return null;
    }

    let gains = 0;
    let losses = 0;

    // Hitung total gains dan losses selama periode
    for (let i = candles.length - period; i < candles.length - 1; i++) {
      const change = candles[i + 1].close - candles[i].close;
      if (change > 0) {
        gains += change;
      } else {
        losses -= change; // Mengurangi karena losses adalah nilai negatif
      }
    }

    // Menghindari pembagian dengan nol
    const averageGain = gains / period;
    const averageLoss = losses / period;

    // RS adalah rasio dari rata-rata gain terhadap rata-rata loss
    const rs = averageLoss === 0 ? 0 : averageGain / averageLoss; // Jika averageLoss adalah 0, set RS ke 0

    const rsi = averageLoss === 0 ? 100 : 100 - (100 / (1 + rs)); // Jika tidak ada kerugian, RSI adalah 100

    console.log('Calculated RSI:', rsi);
    console.log('Total Gains:', gains);
    console.log('Total Losses:', losses);
    console.log('Average Gain:', averageGain);
    console.log('Average Loss:', averageLoss);
    console.log('RS:', rs);
    console.log('Calculated RSI:', rsi);
    this.checkOverboughtOversold(rsi, candles, connection);
    return rsi;
  }



  checkOverboughtOversold(rsi: number | null, candles: any[], connection) {
    if (rsi === null) {
      console.log('RSI calculation was not successful');
      return;
    }

    const currentCandleIndex = candles.length - 1;
    const previousCandleIndex = candles.length - 2;


    if (currentCandleIndex < 1) {
      console.log('Not enough candles to check for confirmation.');
      return;
    }

    // Check for oversold condition
    if (rsi <= 30) {
      if (candles[currentCandleIndex].close > candles[previousCandleIndex].close) {
        console.log(candles[currentCandleIndex].close)
        console.log(candles[previousCandleIndex].close)
        console.log('Market is oversold and confirmed by the current candle being higher than the previous candle.');
        this.executeTrade('buy', connection)
      } else {
        console.log(candles[currentCandleIndex].close)
        console.log(candles[previousCandleIndex].close)
        console.log('Market is oversold but no confirmation from the current candle.');
      }
    }
    // Check for overbought condition
    else if (rsi >= 70) {
      if (candles[currentCandleIndex].close < candles[previousCandleIndex].close) {
        console.log(candles[currentCandleIndex].close)
        console.log(candles[previousCandleIndex].close)
        console.log('Market is overbought and confirmed by the current candle being lower than the previous candle.');
        this.executeTrade('sell', connection)
      } else {
        console.log(candles[currentCandleIndex].close)
        console.log(candles[previousCandleIndex].close)
        console.log('Market is overbought but no confirmation from the current candle.');
      }
    } else {
      console.log('Market is in a neutral condition.');
    }
  }

  // async executeTrade(openMarket, connection) {
  //   if (!connection) {
  //     console.error('Connection is not defined. Cannot execute trade.');
  //     return; // Keluar jika koneksi tidak valid
  //   }
  //   let orderResponse;
  //   switch (openMarket) {
  //     case 'buy':
  //       orderResponse = await connection.createMarketBuyOrder(this.pair, this.volume);
  //       break;

  //     case 'sell':
  //       orderResponse = await connection.createMarketSellOrder(this.pair, this.volume);
  //       break;

  //     default:
  //       console.log('Open market is invalid. Must be "buy" or "sell".');
  //       return;
  //   }

  //   // Menunggu sebentar untuk memastikan order tercatat
  //   await new Promise(resolve => setTimeout(resolve, 2000));
  //   const orderHistory = await connection.historyStorage.getHistoryOrdersByPosition(`${orderResponse.positionId}`);

  //   // Cek apakah ada order dalam riwayat
  //   if (!orderHistory || orderHistory.length === 0) {
  //     console.error('No order history found. Cannot set TP.');
  //     return; // Keluar jika tidak ada riwayat order
  //   }

  //   // Mendapatkan harga setelah order dieksekusi
  //   const executedPrice = orderHistory[0]?.openPrice;
  //   const tipeOrder = orderHistory[0].type

  //   // Hitung TP dan SL
  //   const tp = tipeOrder !== 'ORDER_TYPE_BUY' ? executedPrice - 0.030 : executedPrice + 0.030;
  //   const sl = tipeOrder !== 'ORDER_TYPE_BUY' ? executedPrice + 0.060 : executedPrice - 0.060

  //   await this.setTakeProfit(connection, orderHistory[0]?.id, tp.toFixed(3), sl.toFixed(3));

  // }

  async executeTrade(openMarket, connection) {
    if (!connection) {
      console.error('Connection is not defined. Cannot execute trade.');
      return; // Exit if the connection is not valid
    }

    let orderResponse;

    try {
      // Attempt to create a market order
      switch (openMarket) {
        case 'buy':
          orderResponse = await connection.createMarketBuyOrder(this.pair, this.volume);
          break;

        case 'sell':
          orderResponse = await connection.createMarketSellOrder(this.pair, this.volume);
          break;

        default:
          console.log('Open market is invalid. Must be "buy" or "sell".');
          return; // Exit if the market type is invalid
      }

      // Wait briefly to ensure the order is recorded
      await new Promise(resolve => setTimeout(resolve, 2000));

      const orderHistory = await connection.historyStorage.getHistoryOrdersByPosition(`${orderResponse.positionId}`);

      // Check if there are any orders in history
      if (!orderHistory || orderHistory.length === 0) {
        console.error('No order history found. Cannot set TP.');
        return; // Exit if there is no order history
      }

      // Get the price after the order is executed
      const executedPrice = orderHistory[0]?.openPrice;
      const orderType = orderHistory[0].type;

      // Calculate TP and SL
      const tp = orderType !== 'ORDER_TYPE_BUY' ? executedPrice - 0.200 : executedPrice + 0.200;
      const sl = orderType !== 'ORDER_TYPE_BUY' ? executedPrice + 0.060 : executedPrice - 0.060;

      await this.setTakeProfit(connection, orderHistory[0]?.id, tp.toFixed(3), sl.toFixed(3));

    } catch (error) {
      console.error('An error occurred while executing the trade:', error);
      // Optionally, log the error and continue with the next operation
    }
  }


  async setTakeProfit(connection: any, orderId: any, tp: any, sl: any) {
    try {
      // Pastikan tp dan sl adalah angka
      const takeProfit = Number(tp);
      const stopLoss = Number(sl);

      // Cek apakah konversi berhasil
      if (isNaN(takeProfit) || isNaN(stopLoss)) {
        console.error('Take Profit or Stop Loss is not a valid number.');
        return; // Keluar jika tidak valid
      }

      console.log(`Order ID: ${orderId}`);
      console.log(`Setting TP: ${takeProfit}, SL: ${stopLoss}`);

      await connection.modifyPosition(orderId, stopLoss, takeProfit);
      console.log(`Take Profit for order ${orderId} set to ${takeProfit} and Stop Loss set to ${stopLoss}`);
    } catch (err) {
      console.error('Error setting take profit:', err);
    }
  }

  scheduleNextFetch(account, metaApi, streamConnection) {
    const now: any = new Date();

    const nextFiveMinutes: any = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes - now;

    setTimeout(async () => {
      const { account, metaApi, streamConnection } = await this.initializeMetaApi()
      await this.fetchLastCandleHistories(account);
      const dataCandle = await this.fetchCandleFromDatabase()
      this.calculateRSI(dataCandle, 14, streamConnection);
      this.scheduleNextFetch(account, metaApi, streamConnection);
    }, timeout);
  }
}
