import { describe, expect, it, vi } from 'vitest';
import { clientErrorMessage, GENERIC_ERROR_MESSAGE, handleError, HttpError } from './admin.js';

describe('admin error sanitization', () => {
  it('does not expose runtime error messages to API clients', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await handleError(new Error('D1_ERROR: no such table: tenants'));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe(GENERIC_ERROR_MESSAGE);
      expect(body.error).not.toContain('D1_ERROR');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves expected client-actionable 4xx messages', async () => {
    const res = await handleError(new HttpError(400, 'Invalid OAuth state. Start sign-in again.'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid OAuth state. Start sign-in again.');
  });

  it('does not expose internal 5xx HttpError messages', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await handleError(new HttpError(500, 'GITHUB_APP_PRIVATE_KEY is not configured.'));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe(GENERIC_ERROR_MESSAGE);
      expect(body.error).not.toContain('GITHUB_APP_PRIVATE_KEY');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('uses callback-specific fallback messages for non-client errors', () => {
    const message = clientErrorMessage(
      new Error('SQLITE_ERROR: no such table'),
      'Slack sign-in failed. Try again or contact support.',
    );

    expect(message).toBe('Slack sign-in failed. Try again or contact support.');
  });
});
