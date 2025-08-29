const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const Airtable = require('airtable');
const crypto = require('crypto');

const app = express();
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Initialize Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base('appUNIsu8KgvOlmi0');

// Gmail transporter setup
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Logs storage
let logs = [];
function addLog(message) {
  const timestamp = new Date().toISOString();
  logs.push({ timestamp, message });
  if (logs.length > 100) logs = logs.slice(-100); // Keep last 100 logs
  console.log(`[${timestamp}] ${message}`);
}

// Create Failed Payments table if it doesn't exist
async function ensureFailedPaymentsTable() {
  try {
    // Try to access the table first
    const records = await base('Failed Payments').select({ maxRecords: 1 }).firstPage();
    addLog('Failed Payments table already exists');
    return true;
  } catch (error) {
    addLog('Failed Payments table needs to be created manually in Airtable');
    // Note: Airtable API doesn't support creating tables programmatically
    // The user will need to create this table manually with these fields:
    // - Customer Email (Single line text)
    // - Customer ID (Single line text)
    // - Payment Amount (Currency)
    // - Payment Method (Single line text)
    // - Failure Reason (Long text)
    // - Failure Date (Date & time)
    // - Charge ID (Single line text)
    // - Status (Single select: Failed, Resolved)
    return false;
  }
}

// Send email alert
async function sendEmailAlert(paymentData) {
  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
    subject: `🚨 Payment Failed Alert - ${paymentData.customerEmail}`,
    html: `
      <h2>Payment Failure Notification</h2>
      <p><strong>Customer:</strong> ${paymentData.customerEmail}</p>
      <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency.toUpperCase()}</p>
      <p><strong>Failure Reason:</strong> ${paymentData.failureReason}</p>
      <p><strong>Payment Method:</strong> ${paymentData.paymentMethod}</p>
      <p><strong>Charge ID:</strong> ${paymentData.chargeId}</p>
      <p><strong>Date:</strong> ${new Date(paymentData.failureDate).toLocaleString()}</p>
      
      <p>Please review this failed payment and take appropriate action.</p>
      
      <hr>
      <small>Automated alert from Stripe Payment Monitor</small>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    addLog(`Email alert sent for charge ${paymentData.chargeId}`);
    return true;
  } catch (error) {
    addLog(`Failed to send email alert: ${error.message}`);
    return false;
  }
}

// Add to Airtable
async function addToAirtable(paymentData) {
  try {
    const record = await base('Failed Payments').create([
      {
        fields: {
          'Customer Email': paymentData.customerEmail,
          'Customer ID': paymentData.customerId,
          'Payment Amount': paymentData.amount / 100, // Convert from cents
          'Payment Method': paymentData.paymentMethod,
          'Failure Reason': paymentData.failureReason,
          'Failure Date': new Date(paymentData.failureDate).toISOString(),
          'Charge ID': paymentData.chargeId,
          'Status': 'Failed'
        }
      }
    ]);
    
    addLog(`Added failed payment record to Airtable: ${record[0].id}`);
    return true;
  } catch (error) {
    addLog(`Failed to add to Airtable: ${error.message}`);
    return false;
  }
}

// Process failed payment
async function processFailedPayment(charge) {
  const paymentData = {
    customerEmail: charge.billing_details?.email || 'Unknown',
    customerId: charge.customer || 'Unknown',
    amount: charge.amount,
    currency: charge.currency,
    paymentMethod: charge.payment_method_details?.type || 'Unknown',
    failureReason: charge.failure_message || charge.outcome?.seller_message || 'Unknown reason',
    chargeId: charge.id,
    failureDate: charge.created * 1000 // Convert to milliseconds
  };

  addLog(`Processing failed payment: ${paymentData.chargeId} for ${paymentData.customerEmail}`);

  // Send email alert
  await sendEmailAlert(paymentData);
  
  // Add to Airtable
  await addToAirtable(paymentData);
}

// Webhook signature verification
function verifyWebhookSignature(payload, signature) {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) {
    addLog('WARNING: No webhook secret configured');
    return true; // Allow for testing without signature verification
  }

  const computedSignature = crypto
    .createHmac('sha256', endpointSecret)
    .update(payload)
    .digest('hex');

  const expectedSignature = `sha256=${computedSignature}`;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Stripe Payment Failure Monitor',
    status: 'running',
    description: 'Monitors Stripe for failed payments and sends alerts',
    endpoints: {
      'GET /': 'This status page',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /test': 'Manual test run',
      'POST /webhook': 'Stripe webhook endpoint'
    },
    lastActivity: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    logs: logs.length
  });
});

app.get('/logs', (req, res) => {
  res.json({
    logs: logs.slice(-50), // Return last 50 logs
    total: logs.length
  });
});

app.post('/test', async (req, res) => {
  addLog('Manual test triggered');
  
  // Test email functionality
  const testEmailResult = await sendEmailAlert({
    customerEmail: 'test@example.com',
    customerId: 'cus_test123',
    amount: 2000,
    currency: 'usd',
    paymentMethod: 'card',
    failureReason: 'Test failure reason',
    chargeId: 'ch_test123',
    failureDate: Date.now()
  });

  // Check table exists
  const tableExists = await ensureFailedPaymentsTable();

  res.json({
    message: 'Test completed',
    emailSent: testEmailResult,
    tableExists: tableExists,
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const payload = req.body;

  // Verify webhook signature
  if (!verifyWebhookSignature(payload, signature)) {
    addLog('Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (err) {
    addLog(`Webhook payload parsing failed: ${err.message}`);
    return res.status(400).send('Invalid JSON');
  }

  addLog(`Received webhook: ${event.type}`);

  // Handle different types of failed payment events
  switch (event.type) {
    case 'charge.failed':
      await processFailedPayment(event.data.object);
      break;
    case 'payment_intent.payment_failed':
      if (event.data.object.charges?.data?.length > 0) {
        await processFailedPayment(event.data.object.charges.data[0]);
      }
      break;
    case 'invoice.payment_failed':
      if (event.data.object.charge) {
        // Fetch the charge details
        try {
          const charge = await stripe.charges.retrieve(event.data.object.charge);
          await processFailedPayment(charge);
        } catch (error) {
          addLog(`Failed to retrieve charge for invoice: ${error.message}`);
        }
      }
      break;
    default:
      addLog(`Unhandled webhook event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Error handling middleware
app.use((error, req, res, next) => {
  addLog(`Error: ${error.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  addLog(`Stripe Payment Failure Monitor started on port ${PORT}`);
  
  // Check if table exists on startup
  await ensureFailedPaymentsTable();
});