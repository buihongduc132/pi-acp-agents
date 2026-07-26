/**
 * Tests for shared executor instance behavior
 *
 * These tests verify that in-memory state (activePromises, telemetryMap,
 * steerQueue, interruptedRuns) is preserved across interrupt/resume/steer
 * calls on the SAME executor instance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncExecutor } from '../../src/core/async-executor.js';
import type { AgentCoordinator } from '../../src/coordination/coordinator.js';

// Long-running mock coordinator that doesn't complete immediately
function createSlowMockCoordinator(delayMs = 2000): AgentCoordinator {
	return {
		delegate: async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return {
				text: 'mock response',
				stopReason: 'end_turn',
				sessionId: 'mock-session',
			};
		},
	} as AgentCoordinator;
}

describe('Shared Executor Instance', () => {
	let tempDir: string;
	let coordinator: AgentCoordinator;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'acp-shared-test-'));
		coordinator = createSlowMockCoordinator(2000);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('preserves activePromises map across interrupt/resume calls', async () => {
		const executor = new AsyncExecutor(coordinator, tempDir);

		// Start a long-running async run
		const runId = executor.start('test-agent', 'Long running task', tempDir);

		// Give it time to start
		await new Promise((r) => setTimeout(r, 100));

		// Verify the promise is tracked
		expect(executor.getActivePromises().has(runId)).toBe(true);

		// Interrupt the run
		const interruptResult = executor.interrupt(runId);
		expect(interruptResult.success).toBe(true);

		// Note: interrupt() marks the run as interrupted but doesn't abort the Promise
		// The Promise continues running until it completes or times out
		// This is expected behavior - true Promise cancellation requires AbortController

		// Resume the run
		const resumeResult = executor.resume(runId, 'Continue with new guidance');
		expect(resumeResult.success).toBe(true);

		// Verify a new promise is now tracked (resume creates a new delegate call)
		expect(executor.getActivePromises().has(runId)).toBe(true);
	});

	it('preserves steerQueue across steer and resume calls', async () => {
		const executor = new AsyncExecutor(coordinator, tempDir);

		// Start a run
		const runId = executor.start('test-agent', 'Task', tempDir);
		await new Promise((r) => setTimeout(r, 100));

		// Steer the run (should queue the message)
		const steerResult = executor.steer(runId, 'Focus on error handling');
		expect(steerResult.success).toBe(true);
		expect(steerResult.queued).toBe(true);

		// Verify the message is in the steerQueue
		const queuedMessages = executor.getSteerQueue().get(runId);
		expect(queuedMessages).toBeDefined();
		expect(queuedMessages).toContain('Focus on error handling');

		// Interrupt and resume (should drain the queue)
		executor.interrupt(runId);
		executor.resume(runId, 'Continue');

		// Verify the queue was drained
		expect(executor.getSteerQueue().has(runId)).toBe(false);
	});

	it('preserves telemetryMap across resume calls', async () => {
		const executor = new AsyncExecutor(coordinator, tempDir);

		// Start a run
		const runId = executor.start('test-agent', 'Task', tempDir);
		await new Promise((r) => setTimeout(r, 100));

		// Get initial telemetry
		const initialTelemetry = executor.getTelemetryMap().get(runId);
		expect(initialTelemetry).toBeDefined();
		expect(initialTelemetry!.turns).toBe(0);

		// Interrupt the run
		executor.interrupt(runId);

		// Resume the run
		executor.resume(runId, 'Continue');

		// Verify telemetry is preserved (not reset)
		const resumedTelemetry = executor.getTelemetryMap().get(runId);
		expect(resumedTelemetry).toBeDefined();
		expect(resumedTelemetry!.turns).toBe(0);
	});

	it('preserves interruptedRuns set across interrupt/resume calls', async () => {
		const executor = new AsyncExecutor(coordinator, tempDir);

		// Start a run
		const runId = executor.start('test-agent', 'Task', tempDir);
		await new Promise((r) => setTimeout(r, 100));

		// Interrupt the run
		executor.interrupt(runId);

		// Verify the run is marked as interrupted
		expect(executor.getInterruptedRuns().has(runId)).toBe(true);

		// Resume the run
		executor.resume(runId, 'Continue');

		// Verify the run is no longer marked as interrupted
		expect(executor.getInterruptedRuns().has(runId)).toBe(false);
	});
});
