import type { Config } from 'jest';

const transform: Config['transform'] = {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
};

const config: Config = {
    rootDir: '.',
    testEnvironment: 'node',
    testTimeout: 60_000,
    maxWorkers: 3,
    cacheDirectory: '.jest-cache',
    globalSetup: '<rootDir>/test/support/global-setup.ts',
    globalTeardown: '<rootDir>/test/support/global-teardown.ts',
    collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts', '!src/**/index.ts'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text-summary', 'lcov'],
    coverageThreshold: {
        global: { statements: 85, branches: 71, functions: 80, lines: 87 },
    },
    projects: [
        {
            displayName: 'unit',
            testEnvironment: 'node',
            testMatch: ['<rootDir>/src/**/*.spec.ts'],
            transform,
        },
        {
            displayName: 'e2e',
            testEnvironment: 'node',
            testMatch: ['<rootDir>/test/**/*.e2e-spec.ts', '<rootDir>/test/**/*.spec.ts'],
            transform,
        },
    ],
};

export default config;
