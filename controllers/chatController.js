const { GoogleGenerativeAI } = require("@google/generative-ai");
const Mensagem = require("../models/mensagem");
const Jogador = require("../models/jogador");
const mongoose = require("mongoose");
const cloudinary = require('cloudinary').v2;

const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

// Configuração do Object Storage Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadToCloudinary = (fileBuffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: "agente-ia-multimodal" },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        stream.end(fileBuffer);
    });
};

// =========================================================================
// HEALTH CHECK (Auditoria de Saúde do Servidor)
// =========================================================================
const verificarSaude = async (req, res) => {
    try {
        const estadoDb = mongoose.connection.readyState;
        const bancoConectado = estadoDb === 1 ? "conectado" : "desconectado";

        if (estadoDb !== 1) {
            return res.status(503).json({
                status: "erro",
                bancoDeDados: bancoConectado,
                timestamp: new Date().toISOString()
            });
        }

        return res.status(200).json({
            status: "ok",
            bancoDeDados: bancoConectado,
            timestamp: new Date().toISOString()
        });
    } catch (erro) {
        return res.status(500).json({
            status: "falha",
            erro: erro.message,
            timestamp: new Date().toISOString()
        });
    }
};

// =========================================================================
// FERRAMENTAS DE FUNCTION CALLING (Clima, Moedas e XP)
// =========================================================================

const buscarClimaTempoReal = async (cidade) => {
    try {
        const apiKeyClima = process.env.WEATHER_API_KEY;
        if (!apiKeyClima) return { erro: "Chave WEATHER_API_KEY não configurada." };
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cidade)}&appid=${apiKeyClima}&units=metric&lang=pt_br`;
        const res = await fetch(url);
        if (!res.ok) return { erro: `Não foi possível obter o clima para: "${cidade}".` };
        const data = await res.json();
        return {
            cidade: data.name,
            temperatura: `${Math.round(data.main.temp)}°C`,
            descricao: data.weather[0].description,
            umidade: `${data.main.humidity}%`
        };
    } catch (err) {
        return { erro: "Erro ao processar consulta de clima." };
    }
};

const converterMoeda = async (valor, de, para) => {
    try {
        const url = `https://open.er-api.com/v6/latest/${de.toUpperCase()}`;
        const res = await fetch(url);
        if (!res.ok) return { erro: `Moeda de origem não suportada: ${de}.` };
        const data = await res.json();
        const taxa = data.rates[para.toUpperCase()];
        if (!taxa) return { erro: `Moeda de destino não suportada: ${para}.` };
        const convertido = (valor * taxa).toFixed(2);
        return {
            valorOriginal: `${valor} ${de.toUpperCase()}`,
            valorConvertido: `${convertido} ${para.toUpperCase()}`,
            taxaCambio: taxa.toFixed(4)
        };
    } catch (err) {
        return { erro: "Erro ao processar conversão monetária." };
    }
};

const adicionarXP = async (nickname, quantidade) => {
    try {
        let jogador = await Jogador.findOne({ nome: nickname });
        if (!jogador) {
            jogador = await Jogador.create({ nome: nickname, xp: Math.max(0, quantidade) });
        } else {
            jogador.xp = Math.max(0, jogador.xp + quantidade);
            await jogador.save();
        }
        return { sucesso: true, nome: jogador.nome, xpAtual: jogador.xp };
    } catch (error) {
        return { erro: "Erro ao atualizar XP." };
    }
};

// Schemas JSON das Funções
const declaracaoClima = {
    name: "buscarClimaTempoReal",
    description: "Obtém a temperatura e o clima atual de uma cidade. Use quando o usuário perguntar sobre o tempo ou clima.",
    parameters: {
        type: "OBJECT",
        properties: { cidade: { type: "STRING", description: "Nome da cidade." } },
        required: ["cidade"]
    }
};

const declaracaoMoeda = {
    name: "converterMoeda",
    description: "Converte valores de uma moeda para outra (ex: USD para BRL).",
    parameters: {
        type: "OBJECT",
        properties: {
            valor: { type: "NUMBER", description: "Valor numérico." },
            de: { type: "STRING", description: "Moeda origem (ex: USD)." },
            para: { type: "STRING", description: "Moeda destino (ex: BRL)." }
        },
        required: ["valor", "de", "para"]
    }
};

const declaracaoXP = {
    name: "adicionarXP",
    description: "Adiciona ou retira pontos de XP do jogador com base no desempenho dele nas charadas.",
    parameters: {
        type: "OBJECT",
        properties: {
            nickname: { type: "STRING" },
            quantidade: { type: "NUMBER" }
        },
        required: ["nickname", "quantidade"]
    }
};

// =========================================================================
// CONTROLADOR DE CHAT E MULTIMODAL
// =========================================================================

const conversarMultimodal = async (req, res) => {
    try {
        const { pergunta } = req.body;
        const usuarioId = req.usuario.id;

        if (!req.file) return res.status(400).json({ erro: "Você precisa enviar um arquivo de imagem." });

        const uploadResult = await uploadToCloudinary(req.file.buffer);
        const imagemSecureUrl = uploadResult.secure_url;

        const imagemBase64 = req.file.buffer.toString("base64");
        const inlineData = { data: imagemBase64, mimeType: req.file.mimetype };

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = pergunta || "Analise esta imagem detalhadamente.";

        const result = await model.generateContent([prompt, { inlineData }]);
        const respostaDaIA = result.response.text();

        await Mensagem.create({ usuarioId, remetente: 'usuario', texto: prompt, imagemUrl: imagemSecureUrl });
        await Mensagem.create({ usuarioId, remetente: 'ia', texto: respostaDaIA });

        return res.status(200).json({ sucesso: true, resposta: respostaDaIA, imagemUrl: imagemSecureUrl });
    } catch (erro) {
        console.error("Erro multimodal:", erro);
        return res.status(500).json({ erro: "Erro interno no servidor ao processar imagem." });
    }
};

const obterHistorico = async (req, res) => {
    try {
        const usuarioId = req.usuario.id;
        const historico = await Mensagem.find({ usuarioId }).sort({ timestamp: 1 }).limit(30);
        return res.status(200).json(historico);
    } catch (error) {
        return res.status(500).json({ erro: "Erro ao buscar histórico." });
    }
};

const conversar = async (req, res) => {
    try {
        const { pergunta } = req.body;
        const usuarioId = req.usuario.id;
        const nickname = req.usuario.nome;

        if (!pergunta) return res.status(400).json({ erro: "Você precisa enviar uma 'pergunta'." });

        // 1. Salvar pergunta
        await Mensagem.create({ usuarioId, remetente: 'usuario', texto: pergunta });
        const historicoMsgs = await Mensagem.find({ usuarioId }).sort({ timestamp: 1 }).limit(20);

        // Converte o histórico para o formato aceito pelo startChat
        const chatHistory = historicoMsgs.map(msg => ({
            role: msg.remetente === 'usuario' ? 'user' : 'model',
            parts: [{ text: msg.texto }]
        }));

        // 2. Inicializar modelo com System Instruction e Tools
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            tools: [{ functionDeclarations: [declaracaoClima, declaracaoMoeda, declaracaoXP] }],
            systemInstruction: `Você é o Guardião de um cofre de conhecimento e um robô sarcástico atuando como Mestre do Jogo. O jogador atual é "${nickname}". Proponha charadas e desafie-o a responder. Se ele responder corretamente à charada, chame obrigatoriamente a função 'adicionarXP' com 50 pontos. Se ele errar ou desistir, chame com -10 pontos. Nunca revele diretamente o total de XP dele, apenas comente se ganhou ou perdeu pontos de forma sarcástica.`
        });

        const chat = model.startChat({ history: chatHistory });

        console.log(`⏳ Enviando mensagem para o chat do Gemini...`);
        let result = await chat.sendMessage(pergunta);
        let respostaDaIA = "";

        // 3. Tratamento blindado para capturar Function Calls (compatível com propriedades ou métodos do SDK)
        const fCalls = typeof result.response.functionCalls === 'function' 
            ? result.response.functionCalls() 
            : result.response.functionCalls;
        const call = fCalls && fCalls[0];

        if (call) {
            console.log(`🤖 IA acionou a ferramenta: "${call.name}"`);
            let functionResult = null;

            if (call.name === "buscarClimaTempoReal") {
                functionResult = await buscarClimaTempoReal(call.args.cidade);
            } else if (call.name === "converterMoeda") {
                functionResult = await converterMoeda(call.args.valor, call.args.de, call.args.para);
            } else if (call.name === "adicionarXP") {
                functionResult = await adicionarXP(nickname, call.args.quantidade);
            }

            if (functionResult) {
                const resultFinal = await chat.sendMessage([{
                    functionResponse: {
                        name: call.name,
                        response: functionResult
                    }
                }]);
                respostaDaIA = resultFinal.response.text();
            } else {
                respostaDaIA = resultFinal.response.text();
            }
        } else {
            respostaDaIA = resultFinal.response.text();
        }

        // 4. Salvar resposta final
        await Mensagem.create({ usuarioId, remetente: 'ia', texto: respostaDaIA });

        return res.status(200).json({ sucesso: true, resposta: respostaDaIA });

    } catch (erro) {
        console.error("❌ Erro no chat:", erro);
        return res.status(500).json({ erro: "Erro interno no servidor de IA." });
    }
};

const obterRanking = async (req, res) => {
    try {
        const jogadores = await Jogador.find().sort({ xp: -1 }).limit(10);
        const rankingFormatado = jogadores.map(j => {
            let titulo = "Novato";
            if (j.xp >= 500) titulo = "Lenda 👑";
            else if (j.xp >= 100) titulo = "Guerreiro ⚔️";
            return { nome: `${titulo}: ${j.nome}`, xp: j.xp };
        });
        return res.status(200).json(rankingFormatado);
    } catch (error) {
        return res.status(500).json({ erro: "Erro ao buscar ranking." });
    }
};

const limparHistorico = async (req, res) => {
    try {
        const usuarioId = req.usuario.id;
        await Mensagem.deleteMany({ usuarioId });
        return res.status(200).json({ sucesso: true, mensagem: "Histórico limpo com sucesso!" });
    } catch (erro) {
        return res.status(500).json({ erro: "Erro ao limpar o histórico." });
    }
};

module.exports = {
    verificarSaude,
    conversar,
    conversarMultimodal,
    obterHistorico,
    obterRanking,
    limparHistorico
};