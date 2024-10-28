import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import Candles from './app.entity';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BacktestService implements OnModuleInit {
  private readonly logger = new Logger(BacktestService.name);
  private readonly startDate = new Date('2024-10-28');
  private readonly endDate = new Date('2024-10-29');
  private readonly targetTP = 0.080; // Target TP
  private readonly stopLoss = 0.030; // Target Stop Loss
  private readonly bollingerPeriod = 14; // Periode Bollinger Bands (disesuaikan)
  private readonly stdDevMultiplier = 1.5; // Multiplier untuk deviasi standar (disesuaikan)
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
    await this.fetchAndIdentifyTrend();
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

  async fetchAndIdentifyTrend(): Promise<void> {
    const prices = await this.priceRepository.find({
      where: {
        time: Between(this.startDate, this.endDate),
      },
      order: { time: 'ASC' },
    });

    if (prices.length < 10) {
      console.log("Data tidak cukup untuk mengidentifikasi tren dengan valid.");
      return;
    }

    this.executeTrades(prices);
  }

  private calculateBollingerBands(prices: number[]): { upperBand: number, lowerBand: number, middleBand: number } | null {
    if (prices.length < this.bollingerPeriod) return null;

    const sum = prices.slice(-this.bollingerPeriod).reduce((a, b) => a + b, 0);
    const mean = sum / this.bollingerPeriod;

    const squaredDiffs = prices.slice(-this.bollingerPeriod).map(price => Math.pow(price - mean, 2));
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

    if (latestPrice > bands.upperBand) {
      this.executeTrade('sell');
      return "Potensi overbought: Sell";
    } else if (latestPrice < bands.lowerBand) {
      this.executeTrade('buy');
      return "Potensi oversold: Buy";
    } else if (latestPrice < bands.middleBand) {
      return "Potensi buy: Market kembali ke garis tengah";
    } else {
      return "Stagnant";
    }
  }

  private executeTrades(prices: Candles[]): { trade: string, entryPrice: number, exitPrice: number | null, profit: number }[] {
    const trades: { trade: string; entryPrice: number; exitPrice: number | null; profit: number }[] = [];
    let position: 'buy' | 'sell' | null = null;
    let entryPrice: number | null = null;
    let totalProfit = 0;
    let totalLoss = 0;

    for (let i = 0; i < prices.length; i++) {
      const signal = this.identifyTrendWithIndicators(prices.slice(0, i + 1));
      const currentPrice = Number(prices[i].close);

      // Memeriksa jika posisi buy harus ditutup karena TP atau SL
      if (position === 'buy' && entryPrice !== null) {
        const takeProfitPrice = entryPrice + this.targetTP;
        const stopLossPrice = entryPrice - this.stopLoss;

        if (currentPrice >= takeProfitPrice) {
          const profit = currentPrice - entryPrice;
          trades.push({ trade: 'buy', entryPrice, exitPrice: currentPrice, profit });
          totalProfit += profit;
          console.log(`Take Profit Buy: Entry: ${entryPrice}, Exit: ${currentPrice}, Profit: ${profit.toFixed(3)}`);
          position = null; // Reset posisi
          entryPrice = null; // Reset entryPrice
          continue;
        } else if (currentPrice <= stopLossPrice) {
          const profit = currentPrice - entryPrice; // Negative profit for stop loss
          trades.push({ trade: 'buy', entryPrice, exitPrice: currentPrice, profit });
          totalLoss += Math.abs(profit);
          console.log(`Stop Loss Buy: Entry: ${entryPrice}, Exit: ${currentPrice}, Loss: ${profit.toFixed(3)}`);
          position = null; // Reset posisi
          entryPrice = null; // Reset entryPrice
          continue;
        }
      }

      // Memeriksa jika posisi sell harus ditutup karena TP atau SL
      if (position === 'sell' && entryPrice !== null) {
        const takeProfitPrice = entryPrice - this.targetTP;
        const stopLossPrice = entryPrice + this.stopLoss;

        if (currentPrice <= takeProfitPrice) {
          const profit = entryPrice - currentPrice;
          trades.push({ trade: 'sell', entryPrice, exitPrice: currentPrice, profit });
          totalProfit += profit;
          console.log(`Take Profit Sell: Entry: ${entryPrice}, Exit: ${currentPrice}, Profit: ${profit.toFixed(3)}`);
          position = null; // Reset posisi
          entryPrice = null; // Reset entryPrice
          continue;
        } else if (currentPrice >= stopLossPrice) {
          const profit = entryPrice - currentPrice; // Negative profit for stop loss
          trades.push({ trade: 'sell', entryPrice, exitPrice: currentPrice, profit });
          totalLoss += Math.abs(profit);
          console.log(`Stop Loss Sell: Entry: ${entryPrice}, Exit: ${currentPrice}, Loss: ${profit.toFixed(3)}`);
          position = null; // Reset posisi
          entryPrice = null; // Reset entryPrice
          continue;
        }
      }

      // Membuka posisi baru jika ada sinyal
      if (signal.includes("Buy") && position !== 'buy') {
        position = 'buy';
        entryPrice = currentPrice; // Set entryPrice saat membuka posisi
        trades.push({ trade: 'buy', entryPrice, exitPrice: null, profit: 0 });
        // this.executeTrade('buy');
      } else if (signal.includes("Sell") && position !== 'sell') {
        position = 'sell';
        entryPrice = currentPrice; // Set entryPrice saat membuka posisi
        trades.push({ trade: 'sell', entryPrice, exitPrice: null, profit: 0 });
        // this.executeTrade('sell');
      }
    }

    console.log(`Total Profit: ${totalProfit.toFixed(3)}`);
    console.log(`Total Loss: ${totalLoss.toFixed(3)}`);

    return trades;
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
      await new Promise(resolve => setTimeout(resolve, 2000)); // Tunggu 2 detik
      
      await this.setTakeProfit(this.connection, orderResponse.positionId);
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
