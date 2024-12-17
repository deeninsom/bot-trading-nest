import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import MetaApi from 'metaapi.cloud-sdk';

@Injectable()
export class BotV6Service implements OnModuleInit {
  private accountId = process.env.ACC_ID;
  private readonly logger = new Logger(BotV6Service.name);
  private api = new MetaApi(process.env.TOKEN);
  private connection = null;
  private account = null;
  private pair = 'USDJPY';
  private baseVolume = 0.01; // Volume dasar
  private volume = this.baseVolume; // Volume saat ini
  private maxVolume = 0.06; // Batas volume maksimum
  private lastEntryTime: number | null = null;

  private baseProfit = 0.5
  private baseLoss = 0.2
  async onModuleInit() {
    await this.initializeMetaApi();
    this.scheduleNextFetch();
  }

  private async initializeMetaApi() {
    try {
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);
      this.logger.log('Deploying account');
      await this.account.deploy();
      await this.account.waitConnected();

      this.connection = this.account.getStreamingConnection();
      await this.connection.connect();
      await this.connection.waitSynchronized();
      this.logger.log('MetaApi connection established');
    } catch (error) {
      this.logger.error('Error during MetaApi connection', error);
    }
  }

  private async fetchRealTimePrice() {
    try {
      const marketData = await this.connection.subscribeToMarketData(this.pair);
      return marketData?.ask || null;
    } catch (error) {
      this.logger.error('Error fetching real-time price', error);
      return null;
    }
  }

  private async getLastTwoCandles() {
    try {
      const candles = await this.account.getHistoricalCandles(this.pair, '5m');
      return candles.length >= 3 ? candles.slice(-3) : null;
    } catch (error) {
      this.logger.error('Error fetching last two candles', error);
      return null;
    }
  }

private async analyzeTrend() {
  try {
    const price = await this.fetchRealTimePrice();
    if (!price) return;

    const lastTwoCandles = await this.getLastTwoCandles();
    if (!lastTwoCandles || lastTwoCandles.length !== 3) {
      this.logger.log('Insufficient candle data');
      return;
    }

    const [previousCandle, currentCandle] = lastTwoCandles;
    const trendIsUp = currentCandle.close > previousCandle.close && currentCandle.close > currentCandle.open;
    const trendIsDown = currentCandle.close < previousCandle.close && currentCandle.close < currentCandle.open;

    // Filter dengan MA tambahan
    const movingAverage = (lastTwoCandles[0].close + lastTwoCandles[1].close + lastTwoCandles[2].close) / 3;
    const priceAboveMA = price > movingAverage;

    if (await this.cekOrderOpened() && await this.canEnterNewPosition()) {
      if (trendIsUp && priceAboveMA) {
        await this.openPosition('BUY');
      } else if (trendIsDown && !priceAboveMA) {
        await this.openPosition('SELL');
      }
    }
  } catch (error) {
    this.logger.error('Error analyzing trend', error);
  }
}


  private async openPosition(position: string) {
    try {
      if (position === 'BUY') {
        await this.connection.createMarketBuyOrder(this.pair, this.volume);
        this.logger.log(`Opened BUY position with volume: ${this.volume}`);
      } else if (position === 'SELL') {
        await this.connection.createMarketSellOrder(this.pair, this.volume);
        this.logger.log(`Opened SELL position with volume: ${this.volume}`);
      }
    } catch (error) {
      this.logger.error('Error opening position', error);
    }
  }

  private async cekOrderOpened(): Promise<boolean> {
    const openPositions = this.connection.terminalState.positions;
    return openPositions.length <= 0;
  }

  private async canEnterNewPosition(): Promise<boolean> {
  const now = Date.now();
  if (this.lastEntryTime && now - this.lastEntryTime < 5 * 60 * 1000) {
    this.logger.log('Skipping entry, last entry was less than 5 minutes ago');
    return false;
  }

  if (this.volume === this.baseVolume) {
    this.lastEntryTime = now + 2 * 60 * 1000; // Jeda tambahan 2 menit jika reset volume
  } else {
    this.lastEntryTime = now;
  }

  return true;
}


  private async realTimeCheckOrderOpened() {
    const openPositions = this.connection.terminalState.positions;
    
    for (const position of openPositions) {
      const profit = position.unrealizedProfit;

      console.log({
        id_order: position.id,
        profit: profit
      })
      
      const takeProfit = this.baseProfit * (this.volume / this.baseVolume);
      const targetLoss = this.baseLoss * (this.volume / this.baseVolume);
      
      if (profit !== null) {
      if (Number(profit.toFixed(1)) <= -targetLoss) {
      openPositions.length >= 0 &&  await this.connection.closePosition(position?.id);
        this.logger.log(`Closed position ${position.id} with loss: ${profit}`);
        console.log('MOHON MAAF ANDA KALAH');
        this.volume = this.baseVolume; // Reset volume ke volume dasar
      } else if (Number(profit.toFixed(1)) >= takeProfit) {
    openPositions.length >= 0   && await this.connection.closePosition(position?.id);
        this.logger.log(`Closed position ${position.id} with profit: ${profit}`);
        console.log('SELAMAT ANDA MENANG');
        this.volume = Math.min(this.volume * 2, this.maxVolume); // Gandakan volume, batasi ke maxVolume
        this.logger.log(`Volume setelah menang: ${this.volume}`);
      }
      }
    }
    
  }

  private scheduleNextFetch() {
    setInterval(async () => {
      await this.analyzeTrend();
      await this.realTimeCheckOrderOpened();
    }, 10000); // Eksekusi setiap 3 detik
  }
}
