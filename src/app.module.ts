import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
// import { AppService } from './app.service';
import PairUsdJpy from './app.entity';
import * as dotenv from 'dotenv';
import { EmaService } from './ma-indicator.service';
import { AppService } from './app.service';
import { TestService } from './test2';
// import * as fs from 'fs';
// import * as path from 'path';
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'root',
      password: 'jodi',
      database: 'trading',
      synchronize: false,
      entities: [
        PairUsdJpy
      ],
    }),
    TypeOrmModule.forFeature([PairUsdJpy]),
  ],
  // controllers: [AppController],
  providers: [TestService],
})
export class AppModule { }
