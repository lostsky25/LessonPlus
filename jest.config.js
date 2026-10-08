/** @type {import('jest').Config} */
const nestProject = (displayName, rootDir) => ({
  displayName,
  rootDir,
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          esModuleInterop: true,
          strict: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
});

const config = {
  passWithNoTests: true,
  projects: [
    nestProject('api-gateway', '<rootDir>/apps/api-gateway'),
    nestProject('subscriptions', '<rootDir>/services/subscriptions'),
    nestProject('schedule', '<rootDir>/services/schedule'),
    nestProject('attendance', '<rootDir>/services/attendance'),
    nestProject('transfers', '<rootDir>/services/transfers'),
    nestProject('notifications', '<rootDir>/services/notifications'),
  ],
};

export default config;
