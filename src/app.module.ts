import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import PairUsdJpy from './app.entity';
import * as dotenv from 'dotenv';
import { BacktestService } from './backtest-bb.service';
import { BotService } from './bot';
import { BotV2Service } from './botv2';
import CandlesCoin from './coin.entity';
import { BotCoinService } from './bot-crypto';
import { BotV3Service } from './real';
import { BotV4Service } from './BotV4';
import { BotV5Service } from './botV5'
import { BotV6Service } from './dAlambert'
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      url: 'mysql://avnadmin:AVNS_AWdlIJZKwwWtjFw2hoA@mysql-3fb47401-syihabuddin22.c.aivencloud.com:11856/trading?ssl-mode=REQUIRED',
      synchronize: false,
      ssl: {
        rejectUnauthorized: false
      },
      entities: [
        PairUsdJpy,
        CandlesCoin
      ],
    }),
    TypeOrmModule.forFeature([PairUsdJpy, ]),
  ],
  providers: [BotV6Service],
})
export class AppModule {}
