import ws, { Socket, WebSocketError } from 'k6/ws';
import { check, sleep } from 'k6';
import { setTimeout } from 'k6/experimental/timers';
import exec from 'k6/execution';
import {Trend, Gauge, Rate, Counter} from 'k6/metrics';
import http from "k6/http";

/**
 * 記錄每次的事件物件的響應時間
 */
export class LogTime {
    /**
     *
     * @param name 紀錄的物件key
     */
    constructor(name) {
        this.name = name || '';
        this.trend = new Trend(this.name, true);
    }
    get duration() {
        if (!this.endedTime) return -1;
        return (this.endedTime - this.startTime);
    }
    start() {
        this.startTime = Date.now();
    }
    end() {
        this.endedTime = Date.now();
        this.trend.add(this.duration);
        return this.duration;
    }
}
/**
 * 測試效能的連線物件
 */
export class Performant {
    constructor() {
        // 位址
        this.url = '';
    }
    // 連線
    connect() {
        const { url } = this;
        const params = { tags: { src: 'websocket' } };

        return new Promise((resolve) => {
            // 連線物件
            this.res = ws.connect(url, params, (socket) => {
                this.onConnect(socket);
                // 成功後回傳
                resolve();
            });
            // 自訂事件檢查連線是否成功
            check(this.res, { 'Connected successfully': (r) => r && r.status === 101 });
        });
    }
    // 這邊是撰寫你服務連線完成後事件檢查
    onConnect(socket) {

        // 定義記錄自己的參數
        // 可以使用 Trend, Gauge, Rate, Counter
        const gauge = new Gauge('gaugeRtt');
        // [trend] 紀錄平均值, 最大值, 最小值
        const trend = new LogTime('api_name');
        // [Counter] 記錄執行次數
        const counter = new Counter('api_name');

        // ws連線成功
        socket.on('open', () => {
            console.log(`VU:${__VU} ${new Date().toISOString()} connected`);
            socket.send('onTestcase1');
        });
        // ws連線關閉
        socket.on('close', () => {
            console.log(`VU ${__VU}: disconnected`);
            sleep(1);
        });
        // ws連線訊息
        socket.on('message', (message) => {
            console.log(`VU ${__VU} 長度 ${ message.length * 2 } bytes, 訊息: ${message}`);

            // 這邊處理伺服器傳下來的事件

            if (message === 'onTestcase1') {
                const rtt = trend.end();
                gauge.add(rtt);
                counter.add(1);
            }
        });
        // ws連線失敗
        socket.on('error', (e) => {
            if (e.error() != 'websocket: close sent') {
                console.log(`${__VU} An unexpected error occurred: `, e.error());
            }
        });
    }
}


// 定義不同模式下的參數
const PerfEnvironment = {
    // 運行環境
    scene: __ENV.SCENE,
    // 運行數量
    perf_vus: __ENV.PVUS,
    // 運行延遲時間
    duration: __ENV.DURATION || '1m',
}
// 這個模式是持續送維持vus數量
let iterations_testing = {
    scenarios: {
        iterations: {
            executor: 'shared-iterations',
            // 模擬使用者數量
            vus: 1,
            // 腳本中的函數被執行的次數
            iterations: 1,
            // 總執行時間
            maxDuration: '10m'
        },
        monitor: {
            executor: 'constant-arrival-rate',
            preAllocatedVUs: 1, // 預先建立uv
            timeUnit: '1s',
            rate: 1,
            duration: '1m10s',
            exec: 'monitor'
        }
    }
}
/**
 * 這邊寫法是使用stages方式依照數量時間運行指定vu行為
 */
let ramping_arrival_rate_testing = {
    scenarios: {
        stress: {
            executor: 'ramping-arrival-rate',
            // 開始數量
            preAllocatedVUs: 2,
            // 最大數量
            maxVUs: 2,
            // 觸發次數 timeUnit / startRate = targetTime , 1000 / 10 = 100ms
            startRate: 1,
            // 每隔幾秒執行一次
            timeUnit: '1s',
            stages: [
                { duration: '30s', target: 0 },
                { duration: '5m', target: 10 },
                { duration: '5m', target: 50 },
                { duration: '10m', target: 100 },
                { duration: '30s', target: 0 }
            ]
        }
    }
}
// 單純Stress測試
let stress_testing_options = {
    stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 10 },
        { duration: '10s', target: 50 },
        { duration: '10s', target: 0 }
    ]
}
// 這邊是以時間長度進行測試
let constant_testing = {
    thresholds: {
        gaugeRtt: [ 'value<100' ]
    },
    scenarios: {
        constant: {
            //恆量測試
            executor: 'constant-vus',
            // 模擬使用者數量
            vus: 2,
            // 總執行時間
            duration: PerfEnvironment.duration,
            tags: { type: 'game' }
        }
    }
}
//測試伺服器最大上限
let breakpoint_testing = {
    scenarios: {
        breakpoint: {
            executor: 'ramping-arrival-rate', //Assure load increase if the system slows
            stages: [
                { duration: '10m', target: 20000 }
            ]
        }
    }
}

// 初始化參數
function initialize(scene) {
    if (scene == "iterations") {
        return iterations_testing;
    } else if (scene == "ramping_arrival_rate_testing") {
        return ramping_arrival_rate_testing;
    } else if (scene == "stress") {
        return stress_testing_options;
    } else if (scene == "breakpoint") {
        return breakpoint_testing;
    } else {
        return constant_testing;
    }
}

// [1]設定檔案
export const options = () => {
    // 這邊會寫個初始化參數
    return initialize(PerfEnvironment.scene)
}
// [2]初始化
export function setup() {
    // 這邊可以寫一些程序跑之前需要初始化的物件
    console.info(`setup() ${new Date().toISOString()}`);
}
// [3]開始執行
export default function main() {
    // 這邊取得當下使用者數量
    const per_stage_clients = exec.vu.iterationInScenario == 0 ? exec.vu.idInTest : exec.vu.iterationInScenario;//exec.vu.iterationInScenario;
    const per_stage_duration = 1000;
    const timeout = Math.floor(per_stage_clients) * per_stage_duration; //先算出第幾批次 , 再乘上每批次的時間
    async function defer() {
        let perf = new Performant();
        await perf.connect();
    }
    console.log(`START TIME: ${__VU} / ${timeout} / ${exec.vu.idInTest} / ${exec.vu.iterationInScenario}`);
    setTimeout(() => defer(), timeout);
}

// [4]結束處理
export function teardown(data) {
    // console.log(`teardown code`);
}


