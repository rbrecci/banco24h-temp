/**
 * ============================================================
 *  bancoController.js  —  Backend "Banco 24h" | Fintech Informatica
 *  Arquitetura: Clean Architecture Basica (ES6+)
 *  Regras: do-while + REGEX + formatacao pt-BR
 * ============================================================
 *
 *  COMO CONECTAR A SUA INTERFACE:
 *  1. <script src="controller/bancoController.js"></script>
 *  2. const banco = new BancoController();
 *  3. await banco.init();
 *  4. Use os metodos publicos abaixo.
 *
 *  PERSISTENCIA:
 *  Os dados sao carregados dos JSONs na primeira execucao e
 *  salvos no localStorage do navegador a partir dai. Isso
 *  garante que saldos e extratos sobrevivam ao recarregamento
 *  da pagina, simulando um banco de dados real.
 *  Para resetar os dados ao estado original dos JSONs, chame:
 *  localStorage.removeItem('banco24h_bancos');
 *  localStorage.removeItem('banco24h_extratos');
 *
 *  METODOS PUBLICOS:
 *  - banco.getBancos()            lista de bancos (sem senha/saldo)
 *  - banco.login(cpf, senha)      { ok, mensagem, banco? }
 *  - banco.logout()               encerra sessao
 *  - banco.getSaldo()             { saldoBruto, saldoFormatado }
 *  - banco.sacar()                saque via prompt
 *  - banco.depositar()            deposito via prompt
 *  - banco.transferir()           transferencia para outra conta do sistema
 *  - banco.trocarSenha()          troca de senha via prompt
 *  - banco.getExtrato()           array do historico da sessao atual
 *  - banco.exibirExtrato()        imprime extrato no console
 *  - banco.gerarPDF()             download do extrato em PDF via jsPDF
 * ============================================================
 */

class BancoController {

  constructor() {
    this._bancos   = [];
    this._extratos = [];
    this._sessao   = null;
    this._iniciado = false;

    // Chaves usadas no localStorage
    this._LS_BANCOS   = 'banco24h_bancos';
    this._LS_EXTRATOS = 'banco24h_extratos';

    // Controle de tentativas de login
    // { 'cpf': { tentativas: number, bloqueadoAte: number|null (timestamp) } }
    this._tentativasLogin = {};
    this._MAX_TENTATIVAS  = 3;
    this._BLOQUEIO_MS     = 30000; // 30 segundos

    // REGEX: inteiros (100) ou decimais (99.90)
    this._regexValor = /^\d+(\.\d+)?$/;
  }

  // ============================================================
  //  INICIALIZACAO E PERSISTENCIA
  // ============================================================

  /**
   * Carrega dados do localStorage (se existirem) ou dos JSONs (primeira vez).
   * Deve ser chamado uma vez com await antes de qualquer outra operacao.
   */
  async init() {
    try {
      const bancosLS   = localStorage.getItem(this._LS_BANCOS);
      const extratosLS = localStorage.getItem(this._LS_EXTRATOS);

      if (bancosLS && extratosLS) {
        // Dados ja existem no localStorage — carrega direto
        this._bancos   = JSON.parse(bancosLS);
        this._extratos = JSON.parse(extratosLS);
        console.info('[BancoController] Dados carregados do localStorage.');
      } else {
        // Primeira execucao — busca os JSONs e persiste no localStorage
        const [resBancos, resExtratos] = await Promise.all([
          fetch('assets/bancos.json'),
          fetch('assets/extratos.json')
        ]);

        this._bancos   = await resBancos.json();
        this._extratos = await resExtratos.json();

        this._salvar(); // persiste pela primeira vez
        console.info('[BancoController] Dados carregados dos JSONs e salvos no localStorage.');
      }

      this._iniciado = true;
    } catch (erro) {
      console.error('[BancoController] Falha ao inicializar:', erro);
      throw new Error('Nao foi possivel inicializar o sistema. Verifique os arquivos JSON e o console.');
    }
  }

  /**
   * Persiste o estado atual de bancos e extratos no localStorage.
   * Deve ser chamado apos toda operacao que altere dados.
   */
  _salvar() {
    try {
      localStorage.setItem(this._LS_BANCOS,   JSON.stringify(this._bancos));
      localStorage.setItem(this._LS_EXTRATOS, JSON.stringify(this._extratos));
    } catch (erro) {
      console.error('[BancoController] Erro ao salvar no localStorage:', erro);
    }
  }

  // ============================================================
  //  UTILITARIOS PRIVADOS
  // ============================================================

  _checarInicio() {
    if (!this._iniciado) {
      throw new Error('BancoController nao inicializado. Chame await banco.init() primeiro.');
    }
  }

  _checarSessao() {
    if (!this._sessao) {
      throw new Error('Nenhuma sessao ativa. Faca login primeiro.');
    }
  }

  _formatarBRL(valor) {
    return valor.toLocaleString('pt-br', { style: 'currency', currency: 'BRL' });
  }

  _dataHoraAtual() {
    return new Date().toLocaleString('pt-br');
  }

  /**
   * Registra uma transacao no extrato do banco indicado e persiste.
   * @param {string} bancoid   — id do banco cujo extrato sera atualizado
   * @param {string} tipo      — 'Saque' | 'Deposito' | 'Transferencia Enviada' | etc.
   * @param {number|null} valor
   * @param {number} saldoApos — saldo do banco apos a operacao
   * @param {string} [obs]     — observacao opcional (ex: banco destino)
   */
  _registrarTransacao(bancoid, tipo, valor, saldoApos, obs = '') {
    const extratoBanco = this._extratos.find(e => e.bancoid === bancoid);
    if (!extratoBanco) return;

    extratoBanco.historico.push({
      tipo,
      obs,
      valor:              valor !== null ? valor : undefined,
      valorFormatado:     valor !== null ? this._formatarBRL(valor) : undefined,
      saldoApos,
      saldoAposFormatado: this._formatarBRL(saldoApos),
      dataHora:           this._dataHoraAtual()
    });

    // Persiste apos cada transacao
    this._salvar();
  }

  /**
   * Nucleo de captura de valor monetario com do-while + REGEX.
   * @param {string}   mensagemPrompt
   * @param {function} regrasExtra — (numero) => string|null
   * @returns {number|null}
   */
  _capturarValor(mensagemPrompt, regrasExtra = () => null) {
    let entrada;
    let valorNumerico;
    let erroMensagem = '';

    do {
      const textoPrompt = erroMensagem
        ? `ERRO: ${erroMensagem}\n\n${mensagemPrompt}`
        : mensagemPrompt;

      entrada = prompt(textoPrompt);

      if (entrada === null) {
        console.info('[BancoController] Operacao cancelada pelo usuario.');
        return null;
      }

      entrada = entrada.trim();

      // Validacao 1 — REGEX
      if (!this._regexValor.test(entrada)) {
        erroMensagem = 'Entrada invalida. Digite apenas numeros (ex: 150 ou 99.90).';
        continue;
      }

      valorNumerico = Number(entrada);

      // Validacao 2 — regras de negocio
      const erroNegocio = regrasExtra(valorNumerico);
      if (erroNegocio) {
        erroMensagem = erroNegocio;
        continue;
      }

      erroMensagem = '';

    } while (erroMensagem !== '');

    return valorNumerico;
  }

  // ============================================================
  //  CONTROLE DE TENTATIVAS DE LOGIN
  // ============================================================

  _checarBloqueio(cpf) {
    const reg = this._tentativasLogin[cpf];
    if (!reg || !reg.bloqueadoAte) return { bloqueado: false, mensagem: '' };

    const agora = Date.now();

    if (agora < reg.bloqueadoAte) {
      const seg = Math.ceil((reg.bloqueadoAte - agora) / 1000);
      return {
        bloqueado: true,
        mensagem: `Acesso bloqueado. Tente novamente em ${seg} segundo(s).`
      };
    }

    delete this._tentativasLogin[cpf];
    return { bloqueado: false, mensagem: '' };
  }

  _registrarFalhaLogin(cpf) {
    if (!this._tentativasLogin[cpf]) {
      this._tentativasLogin[cpf] = { tentativas: 0, bloqueadoAte: null };
    }

    this._tentativasLogin[cpf].tentativas += 1;
    const tentativas = this._tentativasLogin[cpf].tentativas;
    const restantes  = this._MAX_TENTATIVAS - tentativas;

    if (tentativas >= this._MAX_TENTATIVAS) {
      this._tentativasLogin[cpf].bloqueadoAte = Date.now() + this._BLOQUEIO_MS;
      console.warn(`[BancoController] CPF bloqueado: ${cpf}`);
      return { tentativasRestantes: 0, bloqueado: true };
    }

    return { tentativasRestantes: restantes, bloqueado: false };
  }

  _resetarTentativas(cpf) {
    delete this._tentativasLogin[cpf];
  }

  // ============================================================
  //  AUTENTICACAO
  // ============================================================

  /**
   * Retorna lista publica dos bancos (sem senha, sem saldo).
   */
  getBancos() {
    this._checarInicio();
    return this._bancos.map(({ id, nome }) => ({ id, nome }));
  }

  /**
   * Autentica um usuario. Respeita o limite de tentativas.
   * @returns {{ ok: boolean, mensagem: string, banco?: object }}
   */
  login(cpf, senha) {
    this._checarInicio();

    const cpfNorm = cpf.trim();

    const bloqueio = this._checarBloqueio(cpfNorm);
    if (bloqueio.bloqueado) {
      return { ok: false, mensagem: bloqueio.mensagem };
    }

    const bancoEncontrado = this._bancos.find(
      b => b.cpf === cpfNorm && b.senha === senha.trim()
    );

    if (!bancoEncontrado) {
      const falha = this._registrarFalhaLogin(cpfNorm);

      if (falha.bloqueado) {
        return {
          ok: false,
          mensagem: `CPF ou senha incorretos. Limite atingido. Acesso bloqueado por ${this._BLOQUEIO_MS / 1000} segundos.`
        };
      }

      return {
        ok: false,
        mensagem: `CPF ou senha incorretos. Tentativas restantes: ${falha.tentativasRestantes}.`
      };
    }

    this._resetarTentativas(cpfNorm);
    this._sessao = bancoEncontrado;

    console.info(`[BancoController] Login: ${this._sessao.nome}`);
    return {
      ok: true,
      mensagem: `Bem-vindo(a) ao ${this._sessao.nome}!`,
      banco: { id: this._sessao.id, nome: this._sessao.nome }
    };
  }

  logout() {
    if (this._sessao) {
      console.info(`[BancoController] Sessao encerrada: ${this._sessao.nome}`);
    }
    this._sessao = null;
  }

  // ============================================================
  //  CONSULTAS
  // ============================================================

  getSaldo() {
    this._checarInicio();
    this._checarSessao();
    return {
      saldoBruto:     this._sessao.saldo,
      saldoFormatado: this._formatarBRL(this._sessao.saldo)
    };
  }

  /**
   * Retorna o historico de transacoes da conta logada.
   */
  getExtrato() {
    this._checarInicio();
    this._checarSessao();
    const extratoBanco = this._extratos.find(e => e.bancoid === this._sessao.id);
    return extratoBanco ? extratoBanco.historico : [];
  }

  exibirExtrato() {
    this._checarInicio();
    this._checarSessao();

    const historico = this.getExtrato();
    console.group(`Extrato — ${this._sessao.nome}`);

    if (historico.length === 0) {
      console.info('Nenhuma transacao registrada.');
    } else {
      historico.forEach((t, i) => {
        const valor = t.valorFormatado ? ` | ${t.valorFormatado}` : '';
        const obs   = t.obs ? ` (${t.obs})` : '';
        console.info(
          `${i + 1}. [${t.dataHora}] ${t.tipo}${obs}${valor} | Saldo apos: ${t.saldoAposFormatado}`
        );
      });
    }

    console.groupEnd();
  }

  /**
   * Gera e faz download do extrato em PDF usando jsPDF.
   * Requer no HTML (antes deste script):
   * <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
   */
  gerarPDF() {
    this._checarInicio();
    this._checarSessao();

    if (typeof window === 'undefined' || !window.jspdf) {
      return { ok: false, mensagem: 'Biblioteca jsPDF nao carregada.' };
    }

    const { jsPDF }   = window.jspdf;
    const doc         = new jsPDF();
    const historico   = this.getExtrato();
    const dataGeracao = this._dataHoraAtual();

    // Cabecalho
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('Banco 24h — Extrato Bancario', 14, 20);

    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`Banco: ${this._sessao.nome}`,                          14, 32);
    doc.text(`CPF: ${this._sessao.cpf}`,                             14, 39);
    doc.text(`Saldo atual: ${this._formatarBRL(this._sessao.saldo)}`,14, 46);
    doc.text(`Gerado em: ${dataGeracao}`,                            14, 53);

    doc.setDrawColor(150, 150, 150);
    doc.line(14, 58, 196, 58);

    // Tabela de transacoes
    doc.setFontSize(10);
    let y = 66;

    if (historico.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.text('Nenhuma transacao registrada.', 14, y);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.text('#',          14, y);
      doc.text('Data/Hora',  22, y);
      doc.text('Tipo',       78, y);
      doc.text('Valor',      135, y);
      doc.text('Saldo Apos', 165, y);

      y += 6;
      doc.setDrawColor(200, 200, 200);
      doc.line(14, y, 196, y);
      y += 5;

      doc.setFont('helvetica', 'normal');

      historico.forEach((t, i) => {
        if (y > 270) { doc.addPage(); y = 20; }

        const tipoTexto = t.obs ? `${t.tipo} (${t.obs})` : t.tipo;

        doc.text(String(i + 1),           14, y);
        doc.text(t.dataHora,              22, y);
        doc.text(tipoTexto,               78, y);
        doc.text(t.valorFormatado || '—', 135, y);
        doc.text(t.saldoAposFormatado,    165, y);
        y += 8;
      });
    }

    // Rodape em todas as paginas
    const totalPaginas = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPaginas; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(150);
      doc.text(
        `Fintech Informatica — Documento gerado automaticamente — Pagina ${p} de ${totalPaginas}`,
        14, 290
      );
    }

    const nomeArquivo = `extrato_${this._sessao.id}_${Date.now()}.pdf`;
    doc.save(nomeArquivo);

    console.info(`[BancoController] PDF gerado: ${nomeArquivo}`);
    return { ok: true, mensagem: `PDF gerado: ${nomeArquivo}` };
  }

  // ============================================================
  //  OPERACOES FINANCEIRAS
  // ============================================================

  sacar() {
    this._checarInicio();
    this._checarSessao();

    const saldoAtual = this._sessao.saldo;

    const valor = this._capturarValor(
      `SAQUE\nSaldo disponivel: ${this._formatarBRL(saldoAtual)}\nDigite o valor para sacar:`,
      (num) => {
        if (num <= 0)         return 'O valor deve ser maior que zero.';
        if (num > saldoAtual) return `Saldo insuficiente. Disponivel: ${this._formatarBRL(saldoAtual)}`;
        return null;
      }
    );

    if (valor === null) return { ok: false, mensagem: 'Operacao cancelada.' };

    this._sessao.saldo -= valor;
    this._registrarTransacao(this._sessao.id, 'Saque', valor, this._sessao.saldo);

    const msg = `Saque de ${this._formatarBRL(valor)} realizado. Novo saldo: ${this._formatarBRL(this._sessao.saldo)}`;
    alert(msg);
    return { ok: true, mensagem: msg };
  }

  depositar() {
    this._checarInicio();
    this._checarSessao();

    const valor = this._capturarValor(
      `DEPOSITO\nDigite o valor para depositar:`,
      (num) => {
        if (num <= 0) return 'O valor deve ser maior que zero.';
        return null;
      }
    );

    if (valor === null) return { ok: false, mensagem: 'Operacao cancelada.' };

    this._sessao.saldo += valor;
    this._registrarTransacao(this._sessao.id, 'Deposito', valor, this._sessao.saldo);

    const msg = `Deposito de ${this._formatarBRL(valor)} realizado. Novo saldo: ${this._formatarBRL(this._sessao.saldo)}`;
    alert(msg);
    return { ok: true, mensagem: msg };
  }

  /**
   * Transferencia entre contas do sistema.
   * Pede o CPF de destino, valida se existe no sistema,
   * debita da conta logada e credita na conta de destino.
   * Ambos os extratos sao atualizados e persistidos.
   */
  transferir() {
    this._checarInicio();
    this._checarSessao();

    // Passo 1 — Captura o CPF de destino
    const cpfDestino = prompt(
      `TRANSFERENCIA\n` +
      `Conta de origem: ${this._sessao.nome} (${this._sessao.cpf})\n\n` +
      `Digite o CPF da conta de destino:`
    );

    if (cpfDestino === null) return { ok: false, mensagem: 'Operacao cancelada.' };

    const cpfDestinoNorm = cpfDestino.trim();

    // Passo 2 — Valida o destino
    if (cpfDestinoNorm === this._sessao.cpf) {
      alert('Nao e possivel transferir para a propria conta.');
      return { ok: false, mensagem: 'CPF de destino igual ao de origem.' };
    }

    const bancoDestino = this._bancos.find(b => b.cpf === cpfDestinoNorm);

    if (!bancoDestino) {
      alert(`CPF "${cpfDestinoNorm}" nao encontrado no sistema.`);
      return { ok: false, mensagem: `Destino nao encontrado: ${cpfDestinoNorm}` };
    }

    // Passo 3 — Captura e valida o valor
    const saldoAtual = this._sessao.saldo;

    const valor = this._capturarValor(
      `TRANSFERENCIA\n` +
      `De: ${this._sessao.nome}\n` +
      `Para: ${bancoDestino.nome} (${bancoDestino.cpf})\n` +
      `Saldo disponivel: ${this._formatarBRL(saldoAtual)}\n\n` +
      `Digite o valor a transferir:`,
      (num) => {
        if (num <= 0)         return 'O valor deve ser maior que zero.';
        if (num > saldoAtual) return `Saldo insuficiente. Disponivel: ${this._formatarBRL(saldoAtual)}`;
        return null;
      }
    );

    if (valor === null) return { ok: false, mensagem: 'Operacao cancelada.' };

    // Passo 4 — Executa a transferencia
    this._sessao.saldo -= valor;
    bancoDestino.saldo += valor;

    // Passo 5 — Registra em ambos os extratos
    this._registrarTransacao(
      this._sessao.id,
      'Transferencia Enviada',
      valor,
      this._sessao.saldo,
      `para ${bancoDestino.nome}`
    );

    this._registrarTransacao(
      bancoDestino.id,
      'Transferencia Recebida',
      valor,
      bancoDestino.saldo,
      `de ${this._sessao.nome}`
    );

    // _registrarTransacao ja chama _salvar(), mas como alteramos
    // bancoDestino.saldo diretamente no array, um _salvar() extra
    // garante que o saldo do destino tambem seja persistido.
    this._salvar();

    const msg =
      `Transferencia de ${this._formatarBRL(valor)} realizada.\n` +
      `Destino: ${bancoDestino.nome}\n` +
      `Novo saldo: ${this._formatarBRL(this._sessao.saldo)}`;

    alert(msg);
    return { ok: true, mensagem: `Transferencia de ${this._formatarBRL(valor)} para ${bancoDestino.nome} realizada.` };
  }

  trocarSenha() {
    this._checarInicio();
    this._checarSessao();

    const senhaAtual = prompt('TROCA DE SENHA\nDigite sua senha atual:');
    if (senhaAtual === null) return { ok: false, mensagem: 'Operacao cancelada.' };

    if (senhaAtual.trim() !== this._sessao.senha) {
      alert('Senha atual incorreta.');
      return { ok: false, mensagem: 'Senha atual incorreta.' };
    }

    const novaSenha = prompt('Digite a nova senha:');
    if (novaSenha === null || novaSenha.trim() === '') {
      return { ok: false, mensagem: 'Operacao cancelada ou senha em branco.' };
    }

    const confirmacao = prompt('Confirme a nova senha:');
    if (confirmacao === null) return { ok: false, mensagem: 'Operacao cancelada.' };

    if (novaSenha.trim() !== confirmacao.trim()) {
      alert('As senhas nao coincidem. Tente novamente.');
      return { ok: false, mensagem: 'As senhas nao coincidem.' };
    }

    this._sessao.senha = novaSenha.trim();
    this._registrarTransacao(this._sessao.id, 'Troca de Senha', null, this._sessao.saldo);

    const msg = 'Senha alterada com sucesso.';
    alert(msg);
    return { ok: true, mensagem: msg };
  }
}

// Exportacao para ambientes com modulos (Node/ES6)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BancoController;
}
