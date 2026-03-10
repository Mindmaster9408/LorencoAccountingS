const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AddonSchema = new Schema({
  app: { type: Schema.Types.ObjectId, ref: 'App', required: true },
  name: { type: String, required: true },               // e.g. "Extra Storage", "Priority Support"
  price: { type: Number, default: 0 },                  // Rands per billing cycle
  billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Addon', AddonSchema);
