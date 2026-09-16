import type { Lab } from '../types/lab'

// TASK3: サーバー未起動のためのダミーデータ。
// バックエンドが動き出したら GET /api/v1/labs の実レスポンスに差し替える。
export const mockLabs: Lab[] = [
  {
    name: 'bgp-basic-3node',
    owner: 'demo-user1',
    nodes: [
      { name: 'r1', kind: 'linux', image: 'frrouting/frr:latest', state: 'running', ipv4_address: '172.20.20.2/24' },
      { name: 'r2', kind: 'linux', image: 'frrouting/frr:latest', state: 'running', ipv4_address: '172.20.20.3/24' },
      { name: 'r3', kind: 'linux', image: 'frrouting/frr:latest', state: 'running', ipv4_address: '172.20.20.4/24' },
    ],
  },
  {
    name: 'ospf-lab-old',
    owner: 'demo-user1',
    nodes: [
      { name: 'r1', kind: 'linux', image: 'frrouting/frr:latest', state: 'exited' },
      { name: 'r2', kind: 'linux', image: 'frrouting/frr:latest', state: 'exited' },
    ],
  },
  {
    name: 'isis-verify',
    owner: 'demo-user2',
    nodes: [
      { name: 'core1', kind: 'linux', image: 'frrouting/frr:latest', state: 'running', ipv4_address: '172.20.21.2/24' },
      { name: 'core2', kind: 'linux', image: 'frrouting/frr:latest', state: 'created' },
    ],
  },
]
