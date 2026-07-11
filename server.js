
// ========================================
// On importe les outils dont on a besoin
// ========================================
 
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
 
// ========================================
// Configuration de base
// ========================================
 
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 5000,   // détecte déco après 5s sans réponse
  pingInterval: 3000   // ping toutes les 3s
});
 
const PORT = 3000;
const ODOO_URL = process.env.ODOO_URL || 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB || 'tracabilite_vehicules';
const ODOO_LOGIN = 'nathanelysee0@gmail.com';
const ODOO_PASSWORD = 'N@th@n2006';
 
// ========================================
// Middlewares
// ========================================
 
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: 'fleet-secret-key',
  resave: false,
  saveUninitialized: false
}));
 
// ========================================
// SUIVI DES CHAUFFEURS CONNECTÉS
// ========================================
// Map : socket.id → { vehicule_id, vehicule_nom, plaque, chauffeur, mission_id }
const chauffeursConnectes = new Map();
 
// Dernières positions connues (même après déco)
// Map : vehicule_id → { lat, lng, plaque, vehicule_nom, timestamp, enligne }
const dernieresPositions = new Map();
 
// ========================================
// ROUTE 1 : Connexion utilisateur
// ========================================
 
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0',
      method: 'call',
      params: { db: ODOO_DB, login: email, password: password }
    });
    const result = authResponse.data.result;
    if (!result || !result.uid) {
      return res.json({ success: false, message: 'Email ou mot de passe incorrect.' });
    }
    const isAdmin = result.is_admin === true || result.is_system === true;
    res.json({
      success: true,
      user: { uid: result.uid, name: result.name, email: email, isAdmin: isAdmin }
    });
  } catch (error) {
    console.error('❌ Erreur login:', error.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});
 
// ========================================
// ROUTE 2 : Récupérer tous les véhicules
// ========================================
 
app.get('/api/vehicles', async (req, res) => {
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.vehicle',
        method: 'search_read',
        args: [[]],
        kwargs: { fields: ['name', 'license_plate', 'driver_id', 'statut'], limit: 100 }
      }
    }, { headers: { Cookie: sessionCookie } });
    const vehicules = response.data.result;
    console.log('✅ Véhicules trouvés:', vehicules ? vehicules.length : 0);
    res.json(vehicules || []);
  } catch (error) {
    console.error('❌ Erreur véhicules:', error.message);
    res.status(500).json({ message: 'Erreur', details: error.message });
  }
});
 
// ========================================
// ROUTE 3 : Récupérer les missions
// ========================================
 
app.get('/api/missions', async (req, res) => {  
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.mission',
        method: 'search_read',
        args: [[['id', '>', 0]]],
        kwargs: {
          fields: ['name', 'vehicle_id', 'driver_id', 'note', 'destination', 'heure_debut', 'heure_fin', 'statut'],
          order: 'id desc',
          limit: 100
        }
      }
    }, { headers: { Cookie: sessionCookie } });
    console.log('Réponse Odoo complète:', JSON.stringify(response.data));
    const missions = response.data.result;
    console.log('✅ Missions trouvées:', missions ? missions.length : 0);
    res.json(missions || []);
  } catch (error) {
    console.error('❌ Erreur chargement missions:', error.message);
    res.status(500).json({ message: 'Erreur', details: error.message });
  }
});
 
app.post('/api/missions', async (req, res) => {
  const { vehicle_id, driver_name, driver_uid, heure_debut } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.mission',
        method: 'create',
        args: [{
          name: `Mission-${Date.now()}`,
          vehicle_id: vehicle_id,
          heure_debut: heure_debut.replace('T', ' ').substring(0, 19),
          statut: 'en_cours',
          note: `Chauffeur: ${driver_name || 'Inconnu'}`
        }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    const missionId = response.data.result;
    if (!missionId) return res.json({ success: false, message: 'Erreur Odoo' });
    if (driver_uid) {
      await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
        jsonrpc: '2.0', method: 'call',
        params: {
          model: 'fleet.vehicle',
          method: 'write',
          args: [[vehicle_id], { driver_id: driver_uid }],
          kwargs: {}
        }
      }, { headers: { Cookie: sessionCookie } });
      console.log(`✅ Chauffeur uid:${driver_uid} assigné au véhicule ${vehicle_id}`);
    }
    io.emit('mission_demarree', { mission_id: missionId, vehicle_id: vehicle_id, driver_name: driver_name });
    console.log(`✅ Mission créée ID: ${missionId}`);
    res.json({ success: true, id: missionId });
  } catch (error) {
    console.error('❌ Erreur création mission:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
 
// ========================================
// ROUTE GPS — sauvegarde position en BDD
// ========================================
 
app.post('/api/gps', async (req, res) => {
  const { vehicle_id, mission_id, latitude, longitude } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.gps.position',
        method: 'create',
        args: [{
          vehicle_id: vehicle_id,
          mission_id: mission_id || false,
          latitude: latitude,
          longitude: longitude
        }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/gps/:mission_id', async (req, res) => {
  const mission_id = parseInt(req.params.mission_id);
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'].join(';');

    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.gps.position',
        method: 'search_read',
        args: [[['mission_id', '=', mission_id]]],  // ← filtre par mission
        kwargs: {
          fields: ['latitude', 'longitude', 'vehicle_id', 'create_date'],
          order: 'create_date asc',
          limit: 500
        }
      }
    }, { headers: { Cookie: cookies } });

    const points = response.data.result || [];
    console.log(`📍 GPS mission ${mission_id}: ${points.length} points`);
    res.json(points);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
 
// ========================================
// ROUTE : Statut d'un véhicule
// ========================================
 
app.put('/api/vehicles/:id/statut', async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  const { statut } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.vehicle',
        method: 'write',
        args: [[vehicleId], statut === 'disponible'
          ? { statut: statut, driver_id: false }
          : { statut: statut }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    console.log(`✅ Véhicule ${vehicleId} → statut: ${statut}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur statut véhicule:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
 
// ========================================
// ROUTE : Terminer une mission
// ========================================
 
app.put('/api/missions/:id/terminer', async (req, res) => {
  const missionId = parseInt(req.params.id);
  const { heure_fin } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.mission',
        method: 'write',
        args: [[missionId], {
          statut: 'terminee',
          heure_fin: heure_fin.replace('T', ' ').substring(0, 19)
        }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    console.log(`✅ Mission ${missionId} terminée`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur terminer mission:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
 
// ========================================
// ROUTE : Destination d'une mission
// ========================================
 
app.put('/api/missions/:id/destination', async (req, res) => {
  const missionId = parseInt(req.params.id);
  const { destination } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.mission',
        method: 'write',
        args: [[missionId], { destination: destination }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
 
// ========================================
// ROUTES CHAUFFEURS
// ========================================
 
app.post('/api/chauffeurs', async (req, res) => {
  const { prenom, nom, email, password, tel } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'].join(';');
    const createUser = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'res.users',
        method: 'create',
        args: [{
          name: `${prenom} ${nom}`,
          login: email,
          email: email,
          sel_groups_1_10_11: 1,
          phone: tel || ''
        }],
        kwargs: {}
      }
    }, { headers: { Cookie: cookies } });
    const userId = createUser.data.result;
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
  jsonrpc: '2.0', method: 'call',
  params: {
    model: 'res.users',
    method: 'write',
    args: [[userId], { password: password }],
    kwargs: {}
  }
}, { headers: { Cookie: cookies } });

// Force le groupe utilisateur interne
await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
  jsonrpc: '2.0', method: 'call',
  params: {
    model: 'res.users',
    method: 'write',
    args: [[userId], { sel_groups_1_10_11: 1 }],
    kwargs: {}
  }
}, { headers: { Cookie: cookies } });

console.log(`✅ Chauffeur créé dans Odoo : ${prenom} ${nom} (ID: ${userId})`);
res.json({ success: true, id: userId });
} catch (error) {
  console.error('❌ Erreur création chauffeur:', error.response?.data || error.message);
  res.status(500).json({ success: false, message: error.message });
}
});
 
app.get('/api/chauffeurs', async (req, res) => {
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'].join(';');
    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'res.users',
        method: 'search_read',
        args: [[['share', '=', false], ['id', '!=', 1], ['active', '=', true]]],
        kwargs: { fields: ['id', 'name', 'email', 'phone', 'active', 'login'], limit: 100 }
      }
    }, { headers: { Cookie: cookies } });
    res.json(response.data.result || []);
  } catch (error) {
    res.status(500).json([]);
  }
});
 
app.delete('/api/chauffeurs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'].join(';');
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'res.users',
        method: 'write',
        args: [[id], { active: false }],
        kwargs: {}
      }
    }, { headers: { Cookie: cookies } });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false });
  }
});
 
app.put('/api/chauffeurs/:id/password', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4)
    return res.status(400).json({ success: false, message: 'Mot de passe trop court' });
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'].join(';');
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'res.users',
        method: 'write',
        args: [[parseInt(req.params.id)], { password }],
        kwargs: {}
      }
    }, { headers: { Cookie: cookies } });
    res.json({ success: true });
  } catch(error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
 
// ========================================
// ROUTES VÉHICULES (CRUD)
// ========================================
 
app.post('/api/vehicles', async (req, res) => {
  const { name, license_plate, statut } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const cookies = authResponse.headers['set-cookie'];
    const sessionCookie = cookies ? cookies.join(';') : '';
    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.vehicle',
        method: 'create',
        args: [{ name, license_plate, statut: statut || 'disponible' }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    res.json({ success: true, id: response.data.result });
  } catch (error) {
    console.error('❌ Erreur création véhicule:', error.message);
    res.status(500).json({ success: false, message: 'Erreur création véhicule' });
  }
});
 
app.put('/api/vehicles/:id/update', async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  const { name, license_plate, statut } = req.body;
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const sessionCookie = authResponse.headers['set-cookie'].join(';');
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.vehicle',
        method: 'write',
        args: [[vehicleId], { name, license_plate, statut }],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    console.log(`✅ Véhicule ${vehicleId} modifié`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur modification véhicule:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
 
app.delete('/api/vehicles/:id', async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const sessionCookie = authResponse.headers['set-cookie'].join(';');
    await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.vehicle',
        method: 'unlink',
        args: [[vehicleId]],
        kwargs: {}
      }
    }, { headers: { Cookie: sessionCookie } });
    console.log(`✅ Véhicule ${vehicleId} supprimé`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur suppression véhicule:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
 
app.get('/api/vehicles/:id/missions', async (req, res) => {
  const vehicleId = parseInt(req.params.id);
  try {
    const authResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: '2.0', method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
    });
    const sessionCookie = authResponse.headers['set-cookie'].join(';');
    const response = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'fleet.mission',
        method: 'search_read',
        args: [[['vehicle_id', '=', vehicleId]]],
        kwargs: {
          fields: ['name', 'destination', 'heure_debut', 'heure_fin', 'statut', 'note'],
          order: 'id desc',
          limit: 50
        }
      }
    }, { headers: { Cookie: sessionCookie } });
    res.json(response.data.result || []);
  } catch (error) {
    console.error('❌ Erreur historique véhicule:', error.message);
    res.status(500).json([]);
  }
});
 
// ========================================
// NOUVELLE ROUTE : État des chauffeurs en ligne
// ========================================
// L'admin peut demander qui est actuellement connecté
 
app.get('/api/chauffeurs/enligne', (req, res) => {
  const enligne = [];
  chauffeursConnectes.forEach((data) => {
    enligne.push({
      vehicule_id:  data.vehicule_id,
      vehicule_nom: data.vehicule_nom,
      plaque:       data.plaque,
      chauffeur:    data.chauffeur,
      mission_id:   data.mission_id,
      connecte_a:   data.connecte_a
    });
  });
  res.json(enligne);
});
 
// ========================================
// SOCKET.IO — GPS Temps réel (AMÉLIORÉ)
// ========================================
 
// Délai en ms avant de considérer un chauffeur hors ligne
// si aucune position reçue (30 secondes)
const TIMEOUT_HORS_LIGNE = 30 * 1000;
const timersHorsLigne = new Map(); // vehicule_id → setTimeout
 
io.on('connection', (socket) => {
  console.log('🔌 Appareil connecté:', socket.id);
 
  // ── 1. Le chauffeur s'identifie au démarrage de mission ──
  // Le driver.html émet 'chauffeur_identifie' avec ses infos
  socket.on('chauffeur_identifie', (data) => {
    const { vehicule_id, vehicule_nom, plaque, chauffeur, mission_id } = data;
 
    // On mémorise ce socket → chauffeur
    chauffeursConnectes.set(socket.id, {
      vehicule_id,
      vehicule_nom,
      plaque,
      chauffeur,
      mission_id,
      connecte_a: new Date().toISOString()
    });
 
    // Met à jour la dernière position connue comme "en ligne"
    if (dernieresPositions.has(String(vehicule_id))) {
      const pos = dernieresPositions.get(String(vehicule_id));
      pos.enligne = true;
      dernieresPositions.set(String(vehicule_id), pos);
    } else {
      dernieresPositions.set(String(vehicule_id), {
        vehicule_id, vehicule_nom, plaque,
        lat: null, lng: null,
        timestamp: new Date().toISOString(),
        enligne: true
      });
    }
 
    // Annule le timer hors-ligne si existant (reconnexion)
    if (timersHorsLigne.has(String(vehicule_id))) {
      clearTimeout(timersHorsLigne.get(String(vehicule_id)));
      timersHorsLigne.delete(String(vehicule_id));
    }
 
    // Notifie l'admin qu'un chauffeur est en ligne
    io.emit('chauffeur_en_ligne', {
      vehicule_id, vehicule_nom, plaque, chauffeur, mission_id
    });
 
    console.log(`✅ Chauffeur identifié : ${chauffeur} → ${plaque} (socket: ${socket.id})`);
  });
 
  // ── 2. Réception de position GPS ──
  socket.on('gps_position', (data) => {
    const { vehicule_id, plaque, lat, lng, vehicule_nom, timestamp } = data;
    console.log('📍 Position reçue:', data);
 
    // Sauvegarde la dernière position connue
    dernieresPositions.set(String(vehicule_id), {
      vehicule_id, vehicule_nom, plaque, lat, lng,
      timestamp: timestamp || new Date().toISOString(),
      enligne: true
    });
 
    // Remet à zéro le timer hors-ligne
    if (timersHorsLigne.has(String(vehicule_id))) {
      clearTimeout(timersHorsLigne.get(String(vehicule_id)));
    }
 
    // Si aucune position reçue après TIMEOUT → hors ligne
    const timer = setTimeout(() => {
      const pos = dernieresPositions.get(String(vehicule_id));
      if (pos) {
        pos.enligne = false;
        dernieresPositions.set(String(vehicule_id), pos);
        io.emit('chauffeur_hors_ligne', {
          vehicule_id, vehicule_nom, plaque,
          derniere_position: pos,
          raison: 'timeout_gps'
        });
        console.log(`⚠️ Véhicule ${plaque} — aucune position depuis ${TIMEOUT_HORS_LIGNE/1000}s`);
      }
      timersHorsLigne.delete(String(vehicule_id));
    }, TIMEOUT_HORS_LIGNE);
 
    timersHorsLigne.set(String(vehicule_id), timer);
 
    // Diffuse la position à tous les admins
    io.emit('vehicle_position_updated', {
      ...data,
      enligne: true,
      timestamp: timestamp || new Date().toISOString()
    });
  });
 
  // ── 3. Chauffeur signale son arrivée ──
  socket.on('chauffeur_arrive', (data) => {
    io.emit('chauffeur_arrive', data);
  });
  socket.on('vehicule_libere', data => {
    io.emit('vehicule_libere', data);
    console.log(`🔓 Véhicule libéré : ${data.plaque}`);
  });
  socket.on('statut_vehicule_change', data => {
    io.emit('statut_vehicule_change', data);
  });
  socket.on('mission_terminee', data => {
    console.log('📡 Broadcast mission_terminee:', data);
    io.emit('mission_terminee', data);
  });
  // ── 4. Déconnexion ──
  socket.on('disconnect', () => {
    console.log('🔌 Appareil déconnecté:', socket.id);
 
    const infos = chauffeursConnectes.get(socket.id);
    if (!infos) return; // C'était un admin ou visiteur
 
    const { vehicule_id, vehicule_nom, plaque, chauffeur, mission_id } = infos;
    chauffeursConnectes.delete(socket.id);
 
    // Met à jour l'état hors ligne immédiatement
    const pos = dernieresPositions.get(String(vehicule_id));
    const derniere_position = pos || null;
 
    if (pos) {
      pos.enligne = false;
      dernieresPositions.set(String(vehicule_id), pos);
    }
 
    // Notifie l'admin
    io.emit('chauffeur_hors_ligne', {
      vehicule_id,
      vehicule_nom,
      plaque,
      chauffeur,
      mission_id,
      derniere_position,
      raison: 'deconnexion'
    });
    // Remet le véhicule en disponible dans Odoo
    if (infos.vehicule_id) {
      axios.post(`${ODOO_URL}/web/session/authenticate`, {
        jsonrpc: '2.0', method: 'call',
        params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD }
      })
      .then(authRes => {
      const cookies = authRes.headers['set-cookie'].join(';');
      // 1. Remet le véhicule disponible
      return axios.post(`${ODOO_URL}/web/dataset/call_kw`, {
        jsonrpc: '2.0', method: 'call',
        params: {
          model: 'fleet.vehicle',
          method: 'write',
          args: [[infos.vehicule_id], { statut: 'disponible', driver_id: false }],
          kwargs: {}
        }
      }, { headers: { Cookie: cookies } }).then(() => ({ cookies }));
    })
    .then(() => {
  // Mission NON terminée automatiquement
  // Le chauffeur doit appuyer sur "Terminer mission"
    })
    .then(() => {
      console.log(`✅ Véhicule ${infos.plaque} libéré — Mission terminée automatiquement`);
      io.emit('vehicule_libere', {
        vehicule_id:  infos.vehicule_id,
        plaque:       infos.plaque,
        vehicule_nom: infos.vehicule_nom
      });
    })
    .catch(err => console.error('❌ Erreur libération:', err.message));
        }
    
        console.log(`⚠️ Chauffeur déconnecté : ${chauffeur} → ${plaque}`);
 
    // Annule le timer GPS si existant
    if (timersHorsLigne.has(String(vehicule_id))) {
      clearTimeout(timersHorsLigne.get(String(vehicule_id)));
      timersHorsLigne.delete(String(vehicule_id));
    }
  });
});
 
// ========================================
// Démarrage du serveur
// ========================================
 
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur démarré sur http://0.0.0.0:${PORT}`);
  console.log(`🌐 Accès réseau : http://172.20.10.5:${PORT}`);
  console.log(`📡 Connexion à Odoo : ${ODOO_URL}`);
});