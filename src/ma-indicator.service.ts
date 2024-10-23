import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import MetaApi from "metaapi.cloud-sdk";
import Candles from "./app.entity";
import { Repository } from "typeorm";

@Injectable()
export class EmaService implements OnModuleInit {
  private readonly logger = new Logger(EmaService.name);
  private token = process.env.TOKEN;
  private accountId = process.env.ACC_ID;
  private pair = 'USDJPY';
  private volume = 0.01;

  constructor(
    @InjectRepository(Candles)
    private pairRepository: Repository<Candles>,
  ) { }

  public async onModuleInit() {
    const { account, metaApi, streamConnection } = await this.initializeMetaApi();
    const dataCandle = await this.fetchCandleFromDatabase()
    await this.checkForTradeOpportunity(dataCandle);
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
  async fetchLastCandleHistories(account: any) {
    const now = new Date();
    const currentWIBTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const startTime = new Date(currentWIBTime.getFullYear(), currentWIBTime.getMonth(), currentWIBTime.getDate(), currentWIBTime.getHours() - 1);
    const candles = await account.getHistoricalCandles(this.pair, '5m', startTime, 0, 1);
    this.saveHistoryCandles(candles);
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
            where: { time: value.time },
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

  calculateEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const ema: number[] = [];
    let previousEma: number;

    for (let i = 0; i < data.length; i++) {
      const currentPrice = data[i];

      if (i < period - 1) {
        ema.push(null); // Not enough data for EMA
      } else if (i === period - 1) {
        const sum = data.slice(0, period).reduce((a, b) => a + b, 0);
        previousEma = sum / period;
        ema.push(previousEma);
      } else {
        const currentEma = (currentPrice - previousEma) * k + previousEma;
        ema.push(currentEma);
        previousEma = currentEma;
      }
    }

    return ema;
  }

  async checkForTradeOpportunity(candles: any) {
    if (candles.length < 100) return; 
    const closingPrices = candles.map(candle => Number(candle.close));
    const ema25 = this.calculateEMA(closingPrices, 25);
    const ema50 = this.calculateEMA(closingPrices, 50);
    const ema100 = this.calculateEMA(closingPrices, 100);

    // // Log EMA yang dihitung
    // console.log('EMA 25:', ema25);
    // console.log('EMA 50:', ema50);
    // console.log('EMA 100:', ema100);

    const latestEma25 = ema25[ema25.length - 1];
    const latestEma50 = ema50[ema50.length - 1];
    const latestEma100 = ema100[ema100.length - 1];
    const previousEma25 = ema25[ema25.length - 2];
    const previousEma50 = ema50[ema50.length - 2];
    const previousEma100 = ema100[ema100.length - 2];

    // Check for bullish crossover
    if (latestEma25 > latestEma50 && previousEma25 <= previousEma50) {
      this.executeTrade('buy');
    }
    // Check for bearish crossover
    else if (latestEma25 < latestEma50 && previousEma25 >= previousEma50) {
      this.executeTrade('sell');
    }else{
      console.log('no signal  ')
    }
  }


  async executeTrade(direction: 'buy' | 'sell') {
    // Logic to execute trade using the MetaApi connection
    console.log(`Executing ${direction} order`);
    // Implement order execution logic...
  }

  scheduleNextFetch(account: any, metaApi: any, streamConnection: any) {
    const now: any = new Date();
    const nextFiveMinutes: any = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0);
    const timeout = nextFiveMinutes.getTime() - now.getTime();

    setTimeout(async () => {
      await this.fetchLastCandleHistories(account);
      const dataCandle = await this.fetchCandleFromDatabase()
      await this.checkForTradeOpportunity(dataCandle);
      this.scheduleNextFetch(account, metaApi, streamConnection);
    }, timeout);
  }
}
