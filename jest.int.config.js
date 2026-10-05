/**
 * Jest config for integration tests only (the *.int.test.ts files under __tests__/int): `npm run test:int`, run by
 * the CI job `integration` against `supabase start` with SUPABASE_DB_URL set (plan §14, §22). The default `npm test`
 * config in package.json also sees these files, and they skip themselves unless that variable is present.
 */
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/__tests__/int/**/*.int.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.expo/'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|standard-navigation)',
  ],
};
