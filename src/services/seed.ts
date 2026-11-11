import { randomUUID } from 'node:crypto';
import type { Workspace } from '../models/types.js';

export function emptyWorkspace(): Workspace {
  return {
    orders: [],
    conversations: [],
    tasks: [],
    jobs: [],
    activity: [],
    processedEvents: [],
    integration: {
      shopDomain: '',
      shopifyToken: '',
      phoneNumberId: '',
      wabaId: '',
      whatsappToken: '',
      templateName: 'order_confirmation_v1',
      languageCode: 'en_US',
    },
    settings: {
      confirmations: false,
      reminders: false,
      faqs: true,
      tracking: true,
      reminderHours: 6,
      timezone: 'Asia/Karachi',
      policy:
        'Our support team is available Monday to Saturday, 10am–6pm. Contact the team for delivery charges, returns, and exchanges.',
    },
  };
}
export function demoWorkspace(): Workspace {
  const w = emptyWorkspace();
  w.settings.confirmations = true;
  w.settings.reminders = true;
  const names = [
    'Ayesha Khan',
    'Hamza Ahmed',
    'Sara Malik',
    'Usman Ali',
    'Fatima Noor',
    'Bilal Hassan',
    'Zainab Shah',
    'Omar Farooq',
    'Maryam Asif',
    'Hassan Raza',
    'Alina Sheikh',
    'Daniyal Akram',
  ];
  const statuses = [
    'CONFIRMED',
    'PENDING',
    'NEEDS_REVIEW',
    'CONFIRMED',
    'PENDING',
    'CONFIRMED',
    'NEEDS_REVIEW',
    'CONFIRMED',
    'CANCELLED',
    'CONFIRMED',
    'PENDING',
    'CONFIRMED',
  ] as const;
  w.orders = names.map((name, i) => ({
    id: randomUUID(),
    shopifyOrderId: `demo-${1048 - i}`,
    number: `#${1048 - i}`,
    name,
    phone: `92300123${String(4500 + i)}`,
    amount: [4250, 2850, 6800, 3450, 1990, 5200][i % 6]!,
    currency: 'PKR',
    status: statuses[i]!,
    isCod: i !== 9,
    financialStatus: i === 5 || i === 9 ? 'paid' : 'pending',
    paymentMethod: i === 9 ? 'Prepaid / Card' : 'Cash on delivery',
    createdAt: new Date(Date.now() - i * 43 * 60_000).toISOString(),
    delivery:
      i === 5
        ? 'Delivered'
        : i === 3 || i === 7
          ? 'In transit'
          : i === 2
            ? 'On hold'
            : i === 11
              ? 'In progress'
              : 'Unfulfilled',
    fulfillmentStatus:
      i === 5
        ? 'DELIVERED'
        : i === 3 || i === 7
          ? 'FULFILLED'
          : i === 2
            ? 'ON_HOLD'
            : i === 11
              ? 'IN_PROGRESS'
              : 'UNFULFILLED',
    trackingCompany: i === 5 || i === 3 || i === 7 ? 'TCS Express' : undefined,
    trackingNumber: i === 5 || i === 3 || i === 7 ? `PK-${48120 + i}` : undefined,
    trackingUrl:
      i === 5 || i === 3 || i === 7 ? `https://track.example/PK-${48120 + i}` : undefined,
    consent: true,
    tags: statuses[i] === 'CONFIRMED' && i !== 9 ? ['COD-CONFIRMED'] : [],
  }));
  w.conversations = w.orders.slice(0, 7).map((o, i) => ({
    id: randomUUID(),
    orderId: o.id,
    human: i === 2 || i === 6,
    unread: i === 2 || i === 6,
    messages: [
      {
        id: randomUUID(),
        direction: 'out',
        text: `Hi ${o.name.split(' ')[0]}, thank you for your order ${o.number}. Your total is PKR ${o.amount.toLocaleString()}. Please confirm your order.`,
        createdAt: o.createdAt,
      },
      {
        id: randomUUID(),
        direction: 'in',
        text: [
          'Yes, please confirm my order.',
          'When will my order arrive?',
          'Could you update my delivery address?',
          'Thank you! Can I get the tracking link?',
          'What is your return policy?',
          'Received my parcel. Thank you!',
          'I need to cancel this order, please.',
        ][i]!,
        createdAt: new Date(Date.parse(o.createdAt) + 60000).toISOString(),
      },
    ],
  }));
  for (const i of [2, 6])
    w.tasks.push({
      id: randomUUID(),
      orderId: w.orders[i]!.id,
      kind: i === 2 ? 'Address change' : 'Cancellation',
      detail:
        i === 2
          ? 'Customer requested a delivery address update. Collect and verify the new address before dispatch.'
          : 'Customer requested cancellation. Check fulfillment before approving.',
      status: 'OPEN',
      createdAt: new Date().toISOString(),
    });
  w.activity = [
    {
      id: randomUUID(),
      text: 'Ayesha Khan confirmed order #1048',
      createdAt: new Date(Date.now() - 180000).toISOString(),
    },
    {
      id: randomUUID(),
      text: 'Address change requested for #1046',
      createdAt: new Date(Date.now() - 900000).toISOString(),
    },
    {
      id: randomUUID(),
      text: 'Bilal Hassan’s order was marked delivered',
      createdAt: new Date(Date.now() - 2100000).toISOString(),
    },
  ];
  return w;
}
