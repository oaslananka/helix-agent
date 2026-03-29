import { describe, it, expect } from 'vitest';
import {
  ToolNotFoundError,
  ToolExecutionError,
  ToolTimeoutError,
  PathTraversalError,
  PolicyDeniedError,
  isHelixAgentError,
  isSecurityError,
  toMcpErrorCode,
} from '../src/errors/index.js';

describe('Typed Errors', () => {
  describe('ToolNotFoundError', () => {
    it('has correct _tag', () => {
      const err = new ToolNotFoundError('repo.list');
      expect(err._tag).toBe('ToolNotFoundError');
      expect(err.toolName).toBe('repo.list');
      expect(err.message).toContain('repo.list');
    });

    it('is instanceof Error', () => {
      expect(new ToolNotFoundError('x')).toBeInstanceOf(Error);
    });

    it('serializes to JSON', () => {
      const err = new ToolNotFoundError('x');
      const json = err.toJSON();
      expect(json._tag).toBe('ToolNotFoundError');
    });
  });

  describe('isHelixAgentError', () => {
    it('returns true for HelixAgentError instances', () => {
      expect(isHelixAgentError(new ToolNotFoundError('x'))).toBe(true);
      expect(isHelixAgentError(new PathTraversalError('/etc/passwd'))).toBe(true);
    });

    it('returns false for plain Error', () => {
      expect(isHelixAgentError(new Error('plain'))).toBe(false);
    });

    it('returns false for non-errors', () => {
      expect(isHelixAgentError('string')).toBe(false);
      expect(isHelixAgentError(null)).toBe(false);
    });
  });

  describe('isSecurityError', () => {
    it('returns true for security errors', () => {
      expect(isSecurityError(new PathTraversalError('/etc'))).toBe(true);
      expect(isSecurityError(new PolicyDeniedError('exec not allowed'))).toBe(true);
    });

    it('returns false for non-security errors', () => {
      expect(isSecurityError(new ToolNotFoundError('x'))).toBe(false);
    });
  });

  describe('toMcpErrorCode', () => {
    it('maps errors to correct MCP codes', () => {
      expect(toMcpErrorCode(new ToolNotFoundError('x'))).toBe('NOT_FOUND');
      expect(toMcpErrorCode(new PathTraversalError('/etc'))).toBe('POLICY_DENIED');
      expect(toMcpErrorCode(new ToolTimeoutError('x', 30000))).toBe('TIMEOUT');
    });
  });
});
