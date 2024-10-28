import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import PairUsdJpy from './app.entity';
import * as dotenv from 'dotenv';
import { TestNewService } from './test3';
import { BacktestService } from './backtest-bb.service';
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
        PairUsdJpy
      ],
    }),
    TypeOrmModule.forFeature([PairUsdJpy]),
  ],
  providers: [BacktestService],
})
export class AppModule {}
