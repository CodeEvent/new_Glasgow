// Test defaults: never hit Meta, and give every required variable a value.
process.env.NODE_ENV = 'test';
process.env.MOCK_WHATSAPP_API = 'true';
process.env.WHATSAPP_ACCESS_TOKEN ??= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ??= '1234567890';
process.env.WHATSAPP_GROUP_ID ??= 'GROUP-SUPERVISORS';
process.env.WHATSAPP_VERIFY_TOKEN ??= 'verify-me';
process.env.TZ_DISPLAY ??= 'UTC';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/gatekeeper_test';

// Bot tests inject their own OCR; never start the real engine by accident.
process.env.OCR_ENABLED ??= 'false';
