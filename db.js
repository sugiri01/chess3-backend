const { Pool } = require('pg');
const Redis = require('ioredis');
require('dotenv').config();

// Postgres (NeonDB) Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Redis (Upstash) Connection
const redis = new Redis(process.env.REDIS_URL);

redis.on('error', (err) => console.log('Redis Client Error', err));
redis.on('connect', () => console.log('Redis Client Connected'));

// Initialize Database Schema
const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE, -- Added email
        password_hash VARCHAR(255) NOT NULL,
        wallet_balance DECIMAL(10, 2) DEFAULT 0.00,
        rating INT DEFAULT 1200,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        draws INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Explicitly try to add columns one by one for existing tables
    // This is robust against "column exists" errors while ensuring missing ones are added
    const addColumn = async (table, col, type) => {
      try {
        await client.query(`SAVEPOINT add_col_${col}`);
        await client.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        await client.query(`RELEASE SAVEPOINT add_col_${col}`);
        console.log(`Added column ${col} to ${table}`);
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT add_col_${col}`);
        // Ignore "duplicate column" error, log others
        if (!e.message.includes('already exists')) {
          console.error(`Failed to add column ${col} to ${table}:`, e.message);
        }
      }
    };

    await addColumn('users', 'email', 'VARCHAR(255) UNIQUE'); // Migration
    await addColumn('users', 'wins', 'INT DEFAULT 0');
    await addColumn('users', 'losses', 'INT DEFAULT 0');
    await addColumn('users', 'draws', 'INT DEFAULT 0');
    await addColumn('users', 'rating', 'INT DEFAULT 1200');
    await addColumn('transactions', 'description', 'VARCHAR(255)');

    // Matches Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id UUID PRIMARY KEY,
        white_player_id UUID REFERENCES users(id),
        black_player_id UUID REFERENCES users(id),
        winner_id UUID REFERENCES users(id),
        result_reason VARCHAR(50),
        pgn TEXT,
        entry_fee DECIMAL(10, 2) DEFAULT 0.00,
        stake_amount DECIMAL(10, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      );
    `);

    // Transactions Table (Wallet)
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        type VARCHAR(20) NOT NULL, -- 'deposit', 'withdrawal', 'entry_fee', 'winnings'
        amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(20) DEFAULT 'completed',
        reference_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Referrals Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID PRIMARY KEY,
        referrer_id UUID REFERENCES users(id),
        referred_user_id UUID REFERENCES users(id),
        bonus_amount DECIMAL(10, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Support/Complaints Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        subject VARCHAR(255),
        message TEXT,
        status VARCHAR(20) DEFAULT 'open', -- 'open', 'resolved'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Company Earnings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_earnings (
        id UUID PRIMARY KEY,
        match_id UUID REFERENCES matches(id),
        amount DECIMAL(10, 2) NOT NULL,
        description VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Password Reset Tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        token VARCHAR(6) NOT NULL, -- 6 digit OTP
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // KYC Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users_kyc (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) UNIQUE,
        full_name VARCHAR(255),
        pan_number VARCHAR(20),
        id_proof_url TEXT,
        selfie_url TEXT,
        status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'verified', 'rejected'
        rejection_reason TEXT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_at TIMESTAMP
      );
    `);

    await client.query('COMMIT');
    console.log('Database schema initialized all tables created/verified');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Failed to initialize database schema', e);
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  redis,
  initDb
};
