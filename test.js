const axios = require('axios');

axios.post('http://localhost:8069/web/session/authenticate', {
  jsonrpc: '2.0', method: 'call',
  params: { db: 'tracabilite_vehicules', login: 'nathanelysee0@gmail.com', password: 'N@th@n2006' }
}).then(r => {
  const cookie = r.headers['set-cookie'].join(';');
  return axios.post('http://localhost:8069/web/dataset/call_kw', {
    jsonrpc: '2.0', method: 'call',
    params: {
      model: 'fleet.mission',
      method: 'search_read',
      args: [[]],
      kwargs: { fields: ['name', 'statut', 'vehicle_id', 'driver_id', 'note'], limit: 10 }
    }
  }, { headers: { Cookie: cookie } });
}).then(r => {
  console.log('Résultat:', JSON.stringify(r.data.result, null, 2));
}).catch(e => console.error('Erreur:', e.message));