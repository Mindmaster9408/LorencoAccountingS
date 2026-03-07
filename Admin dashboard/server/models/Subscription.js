const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SubscriptionSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  app: { type: Schema.Types.ObjectId, ref: 'App', required: true },
  active: { type: Boolean, default: true },
  employeeCount: { type: Number, default: 0 },
  lastReminder: { type: Date },
  paymentStatus: { type: String, enum: ['paid', 'unpaid'], default: 'unpaid' }
});

module.exports = mongoose.model('Subscription', SubscriptionSchema);