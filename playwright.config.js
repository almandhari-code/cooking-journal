module.exports={testDir:'tests',
use:{baseURL:'http://localhost:8123',reducedMotion:'reduce',permissions:['microphone'],launchOptions:{args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}},
projects:[{name:'mobile',use:{viewport:{width:390,height:844}}},{name:'desktop',use:{viewport:{width:1280,height:800}}}],
webServer:{command:'python3 -m http.server 8123',url:'http://localhost:8123',reuseExistingServer:true}};
