const Usuario = require('../models/usuario');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const registrar = async (req, res) => {
    try {
        const { nome, email, senha } = req.body;

        if (!nome || !email || !senha) {
            return res.status(400).json({ erro: "Nome, e-mail e senha são obrigatórios." });
        }

        const usuarioExiste = await Usuario.findOne({ email });
        if (usuarioExiste) {
            return res.status(400).json({ erro: "Este e-mail já está cadastrado." });
        }

        // Criar e salvar o usuário (a senha será criptografada automaticamente pelo pre-save hook)
        const novoUsuario = new Usuario({ nome, email, senha });
        await novoUsuario.save();

        return res.status(201).json({ sucesso: true, mensagem: "Cadastro concluído com sucesso!" });
    } catch (error) {
        console.error("❌ Erro no registro de usuário:", error);
        return res.status(500).json({ erro: "Erro interno no servidor ao cadastrar." });
    }
};

const login = async (req, res) => {
    try {
        const { email, senha } = req.body;

        if (!email || !senha) {
            return res.status(400).json({ erro: "Preencha todos os campos para fazer login." });
        }

        const usuario = await Usuario.findOne({ email });
        if (!usuario) {
            return res.status(400).json({ erro: "E-mail ou senha incorretos." });
        }

        // Comparar senha digitada com a criptografada no banco
        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        if (!senhaValida) {
            return res.status(400).json({ erro: "E-mail ou senha incorretos." });
        }

        // Emitir Crachá Digital (Token JWT) contendo os dados do usuário, válido por 24h
        const token = jwt.sign(
            { id: usuario._id, nome: usuario.nome },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        return res.status(200).json({
            sucesso: true,
            token,
            nome: usuario.nome
        });
    } catch (error) {
        console.error("❌ Erro na autenticação de login:", error);
        return res.status(500).json({ erro: "Erro interno no servidor ao fazer login." });
    }
};

module.exports = { registrar, login };