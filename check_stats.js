const { pool } = require('./db');

const checkStats = async () => {
    try {
        const res = await pool.query('SELECT username, wins, losses, draws, rating, wallet_balance FROM users');
        console.log('User Stats:', res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
};

checkStats();
