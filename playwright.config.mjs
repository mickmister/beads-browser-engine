import { defineConfig } from '@playwright/test';
const names=process.env.ENGINE_BROWSER?[process.env.ENGINE_BROWSER]:['chromium','firefox','webkit'];
export default defineConfig({
 testDir:'./tests/browser',timeout:180000,workers:1,reporter:'list',
 outputDir:'test-results/browser',use:{baseURL:`http://127.0.0.1:${process.env.ENGINE_TEST_PORT??8761}`,trace:'retain-on-failure'},
 projects:names.map(name=>({name,use:{browserName:name}})),
 webServer:{command:'node scripts/serve.mjs',url:`http://127.0.0.1:${process.env.ENGINE_TEST_PORT??8761}`,timeout:30000,reuseExistingServer:false},
});
