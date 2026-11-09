const mongoose = require('mongoose');
const { atlasHint, connectMongo } = require('../utils/dns');
const { detectTransactionSupport } = require('../utils/tx');

const connectDB = async () => {
    try {
        const conn = await connectMongo(mongoose, process.env.MONGO_URI, {
            // Steadier link to Atlas on home / college networks:
            family: 4, // IPv4 only (broken IPv6 routes cause resets on some networks)
            maxIdleTimeMS: 60000, // close idle sockets before routers or antivirus silently cut them
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 10000,
            retryReads: true, // a read cut off by the network is retried once automatically
            retryWrites: true,
        });
        console.log(`MongoDB connected: ${conn.connection.host}`);
        // Bed numbers are now per night: replace the old one-booking-per-bed index with
        // (camp, bed, night) and create the per-night counters' index
        try {
            await require('../modules/lodging/beds').BedAssignment.syncIndexes();
            await require('../modules/lodging/nights').LodgingNight.syncIndexes();
        } catch (e) {
            console.warn(`Index update skipped: ${e.message}`);
        }
        const tx = await detectTransactionSupport();
        console.log(
            tx
                ? 'Transactions: enabled (replica set / Atlas)'
                : 'Transactions: unavailable (standalone server) - using atomic updates with compensation'
        );
        return conn;
    } catch (error) {
        console.error(`Database connection error: ${error.message}`);
        const hint = atlasHint(error.message);
        if (hint) console.error(hint);
        process.exit(1);
    }
};

module.exports = connectDB;
