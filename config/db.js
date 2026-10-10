const mongoose = require('mongoose');
const { detectTransactionSupport } = require('../utils/tx');

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB connected: ${conn.connection.host}`);
        const tx = await detectTransactionSupport();
        console.log(
            tx
                ? 'Transactions: enabled (replica set / Atlas)'
                : 'Transactions: unavailable (standalone server) - using atomic updates with compensation'
        );
        return conn;
    } catch (error) {
        console.error(`Database connection error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;
