import {
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Entity
} from 'typeorm';


@Entity('candlesCoin')
export default class CandlesCoin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'datetime', nullable: true })
  time: Date;

  @Column({ type: 'decimal', precision: 10, scale: 5, nullable: true })
  open: string;

  @Column({ type: 'decimal', precision: 10, scale: 5, nullable: true })
  high: number;

  @Column({ type: 'decimal', precision: 10, scale: 5, nullable: true })
  low: number;

  @Column({ type: 'decimal', precision: 10, scale: 5, nullable: true })
  close: number;

  @Column({ type: 'int', nullable: true })
  tickVolume: number;

  @CreateDateColumn()
  public created_at: Date;

  @UpdateDateColumn()
  public updated_at: Date;
}