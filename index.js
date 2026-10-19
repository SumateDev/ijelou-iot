require('dotenv').config();

const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Middleware de autenticación por Bearer Token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  const expectedToken = process.env.API_BEARER_TOKEN;

  // Si no hay token configurado en el entorno, permitir el acceso (modo desarrollo)
  if (!expectedToken) {
    console.warn('⚠️  API_BEARER_TOKEN no configurado - autenticación deshabilitada');
    return next();
  }

  // Si no se proporciona token en la petición
  if (!token) {
    return res.status(401).json({
      error: 'No autorizado - Token requerido',
      message: 'Debe proporcionar un Bearer token en el header Authorization'
    });
  }

  // Validar token
  if (token !== expectedToken) {
    return res.status(403).json({
      error: 'Acceso denegado - Token inválido',
      message: 'El token proporcionado no es válido'
    });
  }

  next();
}

// Aplicar autenticación a todas las rutas de la API (excepto health check)
app.use('/api', (req, res, next) => {
  // Permitir health check sin autenticación para monitoreo
  if (req.path === '/health') {
    return next();
  }
  authenticateToken(req, res, next);
});

// Configuración MQTT
const mqttOptions = {
  host: process.env.MQTT_HOST || 'mosquitto',
  port: process.env.MQTT_PORT || 1883,
  username: process.env.MQTT_USERNAME, // Nueva opción para usuario
  password: process.env.MQTT_PASSWORD, // Nueva opción para contraseña
  keepalive: 60,
  reconnectPeriod: 5000, // Aumentado a 5 segundos
  connectTimeout: 30000, // 30 segundos de timeout
  clean: true,
  rejectUnauthorized: false
};

// Validar credenciales MQTT si están configuradas
if (mqttOptions.username && !mqttOptions.password) {
  console.warn('⚠️  Se configuró usuario MQTT pero no contraseña');
}
if (!mqttOptions.username && mqttOptions.password) {
  console.warn('⚠️  Se configuró contraseña MQTT pero no usuario');
}

// Variables globales
let client = null;
let deviceStates = {};
let isConnected = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 10;

// Función para conectar con reintentos
async function connectToMQTT() {
  return new Promise((resolve, reject) => {
    console.log(`Intentando conectar a MQTT broker: ${mqttOptions.host}:${mqttOptions.port}`);
    console.log(`Intento ${connectionAttempts + 1}/${MAX_CONNECTION_ATTEMPTS}`);
    
    // Mostrar información de autenticación (sin mostrar la contraseña)
    if (mqttOptions.username) {
      console.log(`🔐 Usando autenticación - Usuario: ${mqttOptions.username}`);
    } else {
      console.log('🔓 Conectando sin autenticación');
    }
    
    // Crear cliente MQTT
    client = mqtt.connect(`mqtt://${mqttOptions.host}:${mqttOptions.port}`, mqttOptions);
    
    const connectionTimeout = setTimeout(() => {
      if (!isConnected) {
        console.log('Timeout de conexión alcanzado');
        client.end();
        retryConnection();
      }
    }, mqttOptions.connectTimeout);
    
    client.on('connect', () => {
      clearTimeout(connectionTimeout);
      isConnected = true;
      connectionAttempts = 0;
      console.log('✅ Conectado al broker MQTT exitosamente');
      
      // Suscribirse a todos los topics de Tasmota
      client.subscribe('stat/+/+', (err) => {
        if (err) console.error('Error suscribiendo:', err);
        else console.log('Suscrito a stat/+/+');
      });
      
      // Suscribirse a telemetría
      client.subscribe('tele/+/+', (err) => {
        if (err) console.error('Error suscribiendo a telemetría:', err);
        else console.log('Suscrito a tele/+/+');
      });
      
      resolve(client);
    });
    
    client.on('error', (error) => {
      clearTimeout(connectionTimeout);
      console.error(`❌ Error MQTT (intento ${connectionAttempts + 1}):`, error.message);
      
      // Manejar errores específicos de autenticación
      if (error.message.includes('Not authorized') || error.message.includes('Connection refused')) {
        console.error('🔐 Error de autenticación - Verifica usuario y contraseña');
      }
      
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || 
          error.message.includes('Not authorized')) {
        retryConnection();
      } else {
        reject(error);
      }
    });
    
    client.on('close', () => {
      isConnected = false;
      console.log('🔌 Conexión MQTT cerrada');
    });
    
    client.on('disconnect', () => {
      isConnected = false;
      console.log('🔌 Desconectado del broker MQTT');
    });
    
    client.on('reconnect', () => {
      console.log('🔄 Reintentando conexión MQTT...');
    });
    
    function retryConnection() {
      connectionAttempts++;
      
      if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
        const errorMsg = `No se pudo conectar al broker MQTT después de ${MAX_CONNECTION_ATTEMPTS} intentos`;
        console.error(errorMsg);
        reject(new Error(errorMsg));
        return;
      }
      
      const retryDelay = Math.min(5000 * connectionAttempts, 30000); // Backoff exponencial limitado
      console.log(`⏳ Reintentando en ${retryDelay/1000} segundos...`);
      
      setTimeout(() => {
        connectToMQTT().then(resolve).catch(reject);
      }, retryDelay);
    }
  });
}

// Manejar mensajes MQTT
function setupMessageHandler() {
  if (!client) return;
  
  client.on('message', (topic, message) => {
    try {
      const topicParts = topic.split('/');
      const deviceName = topicParts[1];
      const messageType = topicParts[2];
      
      if (!deviceStates[deviceName]) {
        deviceStates[deviceName] = {};
      }
      
      // Intentar parsear JSON
      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch (e) {
        payload = message.toString();
      }
      
      deviceStates[deviceName][messageType] = {
        payload: payload,
        timestamp: new Date().toISOString()
      };
      
      console.log(`📨 Mensaje recibido - ${topic}: ${message.toString()}`);
    } catch (error) {
      console.error('Error procesando mensaje:', error);
    }
  });
}

// Función helper para verificar conexión
function ensureConnection() {
  return isConnected && client && !client.disconnecting;
}

// Rutas de la API
app.use('/docs', express.static(path.join(__dirname, 'docs')));
app.use('/ttlock-docs', express.static(path.join(__dirname, 'ttlock-docs')));

// GET - Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mqtt_connected: isConnected,
    mqtt_authenticated: !!mqttOptions.username,
    api_authentication_enabled: !!process.env.API_BEARER_TOKEN,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// GET - Obtener estado de todos los dispositivos
app.get('/api/devices', (req, res) => {
  if (!ensureConnection()) {
    return res.status(503).json({ 
      error: 'MQTT broker no disponible',
      mqtt_connected: isConnected 
    });
  }
  
  res.json({
    devices: deviceStates,
    mqtt_connected: isConnected,
    device_count: Object.keys(deviceStates).length
  });
});

// GET - Obtener estado de un dispositivo específico
app.get('/api/devices/:deviceName', (req, res) => {
  if (!ensureConnection()) {
    return res.status(503).json({ 
      error: 'MQTT broker no disponible',
      mqtt_connected: isConnected 
    });
  }
  
  const { deviceName } = req.params;
  const device = deviceStates[deviceName];
  
  if (!device) {
    return res.status(404).json({ error: 'Dispositivo no encontrado' });
  }
  
  res.json({
    device: deviceName,
    data: device,
    mqtt_connected: isConnected
  });
});

// POST - Enviar comando a un dispositivo
app.post('/api/devices/:deviceName/command', (req, res) => {
  if (!ensureConnection()) {
    return res.status(503).json({ 
      error: 'MQTT broker no disponible',
      mqtt_connected: isConnected 
    });
  }
  
  const { deviceName } = req.params;
  const { command, value } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Comando requerido' });
  }
  
  const topic = `cmnd/${deviceName}/${command}`;
  const payload = value !== undefined ? value.toString() : '';
  
  client.publish(topic, payload, (err) => {
    if (err) {
      console.error('Error enviando comando:', err);
      return res.status(500).json({ error: 'Error enviando comando' });
    }
    
    console.log(`📤 Comando enviado - ${topic}: ${payload}`);
    res.json({ 
      success: true, 
      topic: topic, 
      payload: payload,
      timestamp: new Date().toISOString()
    });
  });
});

// POST - Controlar power (encender/apagar)
app.post('/api/devices/:deviceName/power', (req, res) => {
  if (!ensureConnection()) {
    return res.status(503).json({ 
      error: 'MQTT broker no disponible',
      mqtt_connected: isConnected 
    });
  }
  
  const { deviceName } = req.params;
  const { state } = req.body; // "ON", "OFF", "TOGGLE"
  
  if (!state || !['ON', 'OFF', 'TOGGLE'].includes(state.toUpperCase())) {
    return res.status(400).json({ error: 'Estado debe ser ON, OFF o TOGGLE' });
  }
  
  const topic = `cmnd/${deviceName}/Power`;
  const payload = state.toUpperCase();
  
  client.publish(topic, payload, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Error controlando dispositivo' });
    }
    
    console.log(`⚡ Power command - ${deviceName}: ${payload}`);
    res.json({ 
      success: true, 
      device: deviceName,
      command: 'Power',
      state: payload,
      timestamp: new Date().toISOString()
    });
  });
});

// GET - Obtener información del sistema
app.get('/api/system/info', (req, res) => {
  res.json({
    mqtt_broker: {
      host: mqttOptions.host,
      port: mqttOptions.port,
      connected: isConnected,
      authenticated: !!mqttOptions.username,
      username: mqttOptions.username || null
    },
    connected_devices: Object.keys(deviceStates).length,
    uptime: process.uptime(),
    connection_attempts: connectionAttempts,
    timestamp: new Date().toISOString()
  });
});

// Inicializar la aplicación
async function initializeApp() {
  try {
    console.log('🚀 Iniciando API MQTT...');
    console.log(`📍 Variables de entorno:
    - MQTT_HOST: ${process.env.MQTT_HOST || 'mosquitto'}
    - MQTT_PORT: ${process.env.MQTT_PORT || 1883}
    - MQTT_USERNAME: ${mqttOptions.username ? '***configurado***' : 'no configurado'}
    - MQTT_PASSWORD: ${mqttOptions.password ? '***configurado***' : 'no configurado'}
    - API_BEARER_TOKEN: ${process.env.API_BEARER_TOKEN ? '***configurado***' : 'no configurado (modo desarrollo)'}
    - PORT: ${port}`);
    
    // Iniciar servidor HTTP primero
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`🌐 API MQTT ejecutándose en puerto ${port}`);
    });
    
    // Luego conectar a MQTT con reintentos
    await connectToMQTT();
    setupMessageHandler();
    
    console.log('✅ Aplicación inicializada completamente');
    
    // Manejo de cierre graceful
    process.on('SIGINT', () => {
      console.log('\n🛑 Cerrando aplicación...');
      if (client) {
        client.end();
      }
      server.close(() => {
        console.log('👋 Aplicación cerrada');
        process.exit(0);
      });
    });
    
    process.on('SIGTERM', () => {
      console.log('\n🛑 SIGTERM recibido, cerrando aplicación...');
      if (client) {
        client.end();
      }
      server.close(() => {
        console.log('👋 Aplicación cerrada');
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error('❌ Error inicializando aplicación:', error);
    
    // Aun si MQTT falla, mantener el servidor HTTP activo
    console.log('⚠️  Continuando sin conexión MQTT - la API estará disponible pero con funcionalidad limitada');
  }
}

// Iniciar aplicación
initializeApp();
