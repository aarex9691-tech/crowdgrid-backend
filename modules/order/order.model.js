const mongoose = require('mongoose');

/**
 * A checkout order: the paid items in a pilgrim's cart (paid camps, bus passes).
 * Prices are always computed on the server when the order is created.
 *
 *   PENDING --pay--> PROCESSING --approved--> PAID      (passes issued)
 *                               --declined--> PENDING   (try again)
 */
const itemSchema = new mongoose.Schema(
    {
        kind: { type: String, enum: ['LODGING', 'TRANSIT', 'EVENT'], required: true },
        refId: { type: mongoose.Schema.Types.ObjectId, required: true }, // lodging, route or public event
        input: mongoose.Schema.Types.Mixed, // beds, dates, guest names (lodging only)
        label: String,
        detail: String,
        amount: { type: Number, required: true, min: 0 }, // rupees
        status: { type: String, enum: ['PENDING', 'ISSUED', 'FAILED'], default: 'PENDING' },
        error: String,
        passId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pass' },
    },
    { _id: true }
);

const orderSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        items: { type: [itemSchema], validate: [(v) => v.length > 0 && v.length <= 10, 'An order holds 1 to 10 items'] },
        total: { type: Number, required: true, min: 0 },
        currency: { type: String, default: 'INR' },
        status: { type: String, enum: ['PENDING', 'PROCESSING', 'PAID', 'CANCELLED'], default: 'PENDING' },
        payment: {
            provider: String, // 'SIMULATED' today; 'RAZORPAY' later
            method: String, // UPI | CARD
            account: String, // masked, e.g. ramesh@okaxis or **** 4242
            reference: String,
            paidAt: Date,
            lastError: String,
        },
        refunded: { type: Number, default: 0 }, // items that could not be issued after payment
    },
    { timestamps: true }
);

orderSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
