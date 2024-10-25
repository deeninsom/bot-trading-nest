// import { Module } from '@nestjs/common';
// import { TypeOrmModule } from '@nestjs/typeorm';
// import { AppController } from './app.controller';
// // import { AppService } from './app.service';
// import PairUsdJpy from './app.entity';
// import * as dotenv from 'dotenv';
// import { EmaService } from './ma-indicator.service';
// import { AppService } from './app.service';
// import { TestService } from './test2';
// import { TestNewService } from './test3';
// // import * as fs from 'fs';
// // import * as path from 'path';
// dotenv.config();

// @Module({
//   imports: [
//     TypeOrmModule.forRoot({
//       type: 'mysql',
//       host: 'mysql-3fb47401-syihabuddin22.c.aivencloud.com',
//       port: 11856,
//       username: 'avnadmin ',
//       password: 'AVNS_ZKdQgdU9FS_Z_ahjoHH',
//       database: 'defaultdb',
//       synchronize: false,
//       ssl: {
//         rejectUnauthorized: false
//       }, 
//       entities: [
//         PairUsdJpy
//       ],
//     }),
//     TypeOrmModule.forFeature([PairUsdJpy]),
//   ],
//   // controllers: [AppController],
//   providers: [TestNewService],
// })
// export class AppModule { }


import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import PairUsdJpy from './app.entity';
import * as dotenv from 'dotenv';
import { TestNewService } from './test3';
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      url: 'mysql://avnadmin:AVNS_AWdlIJZKwwWtjFw2hoA@mysql-3fb47401-syihabuddin22.c.aivencloud.com:11856/trading?ssl-mode=REQUIRED',
      synchronize: true,
      ssl: {
        rejectUnauthorized: false
      },
      entities: [
        PairUsdJpy
      ],
    }),
    TypeOrmModule.forFeature([PairUsdJpy]),
  ],
  providers: [TestNewService],
})
export class AppModule {}
