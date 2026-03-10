const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PackageSchema = new Schema({
  app: { type: Schema.Types.ObjectId, ref: 'App', required: true },
  name: { type: String, required: true },               // e.g. "Starter", "Professional"
  price: { type: Number, default: 0 },                  // Rands per billing cycle
  billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
  maxEmployees: { type: Number, default: 0 },           // 0 = unlimited
  features: [{ type: String }],                         // Feature bullet points
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Package', PackageSchema);
