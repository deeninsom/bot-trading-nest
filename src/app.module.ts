import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import PairUsdJpy from './app.entity';
import * as dotenv from 'dotenv';
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.PORT, 10),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'jodi',
      database: process.env.DB_NAME || 'trading',
      synchronize: Boolean(process.env.SYNC_DB),
      // ssl: Boolean(process.env.SSL),
      entities: [
        PairUsdJpy
      ],
    }),
    TypeOrmModule.forFeature([PairUsdJpy]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
