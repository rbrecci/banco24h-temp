/**
 * ============================================================
 *  bancoController.js  —  Backend "Banco 24h" | Fintech Informatica
 *  Arquitetura: Clean Architecture Basica (ES6+)
 *  Regras: do-while + REGEX + formatacao pt-BR
 * ============================================================
 *
 *  PERSISTENCIA:
 *  Primeira execucao: carrega os JSONs e salva no localStorage.
 *  Execucoes seguintes: le diretamente do localStorage.
 *  Para resetar: localStorage.removeItem('banco24h_bancos')
 *                localStorage.removeItem('banco24h_extratos')
 *
 *  METODOS PUBLICOS:
 *  - banco.getBancos()                lista de bancos (sem senha/saldo)
 *  - banco.login(cpf, senha)          { ok, mensagem, banco? }
 *  - banco.logout()                   encerra sessao
 *  - banco.getSaldo()                 { saldoBruto, saldoFormatado }
 *  - banco.sacar(valor)               executa saque com valor ja validado
 *  - banco.depositar(valor)           executa deposito com valor ja validado
 *  - banco.transferir(cpfDest, valor) executa transferencia com dados ja validados
 *  - banco.trocarSenha(atual, nova)   executa troca de senha com dados ja validados
 *  - banco.getExtrato()               array do historico da conta logada
 *  - banco.exibirExtrato()            imprime extrato no console
 *  - banco.gerarPDF()                 download do extrato em PDF via jsPDF
 *  - banco.validarValor(str)          valida string de entrada monetaria
 *  - banco.validarCPFDestino(cpf)     valida se CPF existe e nao e o proprio
 * ============================================================
 */

class BancoController {

  constructor() {
    this._bancos   = [];
    this._extratos = [];
    this._sessao   = null;
    this._iniciado = false;

    this._LS_BANCOS   = 'banco24h_bancos';
    this._LS_EXTRATOS = 'banco24h_extratos';

    // { 'cpf': { tentativas: number, bloqueadoAte: number|null } }
    this._tentativasLogin = {};
    this._MAX_TENTATIVAS  = 3;
    this._BLOQUEIO_MS     = 30000;

    // Aceita inteiros (100) ou decimais (99.90)
    this._regexValor = /^\d+(\.\d+)?$/;
  }

  // ============================================================
  //  INICIALIZACAO E PERSISTENCIA
  // ============================================================

  async init() {
    try {
      const bancosLS   = localStorage.getItem(this._LS_BANCOS);
      const extratosLS = localStorage.getItem(this._LS_EXTRATOS);

      if (bancosLS && extratosLS) {
        this._bancos   = JSON.parse(bancosLS);
        this._extratos = JSON.parse(extratosLS);
        console.info('[BancoController] Dados carregados do localStorage.');
      } else {
        const [resBancos, resExtratos] = await Promise.all([
          fetch('assets/bancos.json'),
          fetch('assets/extratos.json')
        ]);
        this._bancos   = await resBancos.json();
        this._extratos = await resExtratos.json();
        this._salvar();
        console.info('[BancoController] Dados carregados dos JSONs e salvos no localStorage.');
      }

      this._iniciado = true;
    } catch (erro) {
      console.error('[BancoController] Falha ao inicializar:', erro);
      throw new Error('Nao foi possivel inicializar o sistema.');
    }
  }

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
    if (!this._iniciado) throw new Error('Controller nao inicializado.');
  }

  _checarSessao() {
    if (!this._sessao) throw new Error('Nenhuma sessao ativa.');
  }

  _formatarBRL(valor) {
    return valor.toLocaleString('pt-br', { style: 'currency', currency: 'BRL' });
  }

  _dataHoraAtual() {
    return new Date().toLocaleString('pt-br');
  }

  /**
   * Registra uma transacao e persiste.
   * @param {string}      bancoid
   * @param {string}      tipo
   * @param {number|null} valor
   * @param {number}      saldoApos
   * @param {string}      [obs]
   * @param {'debito'|'credito'|'neutro'} [natureza]
   */
  _registrarTransacao(bancoid, tipo, valor, saldoApos, obs = '', natureza = 'neutro') {
    const extratoBanco = this._extratos.find(e => e.bancoid === bancoid);
    if (!extratoBanco) return;

    extratoBanco.historico.push({
      tipo,
      obs,
      natureza,
      valor:              valor !== null ? valor : undefined,
      valorFormatado:     valor !== null ? this._formatarBRL(valor) : undefined,
      saldoApos,
      saldoAposFormatado: this._formatarBRL(saldoApos),
      dataHora:           this._dataHoraAtual()
    });

    this._salvar();
  }

  // ============================================================
  //  VALIDACOES PUBLICAS
  //  A interface chama estes metodos para validar os dados
  //  capturados pelos inputs do modal antes de executar a operacao.
  // ============================================================

  /**
   * Valida uma string de valor monetario.
   * @param {string} entrada
   * @returns {{ ok: boolean, valor?: number, mensagem: string }}
   */
  validarValor(entrada) {
    if (!entrada || !this._regexValor.test(entrada.trim())) {
      return { ok: false, mensagem: 'Digite apenas numeros (ex: 150 ou 99.90).' };
    }
    const valor = Number(entrada.trim());
    if (valor <= 0) {
      return { ok: false, mensagem: 'O valor deve ser maior que zero.' };
    }
    return { ok: true, valor, mensagem: '' };
  }

  /**
   * Valida o CPF de destino de uma transferencia.
   * @param {string} cpf
   * @returns {{ ok: boolean, banco?: object, mensagem: string }}
   */
  validarCPFDestino(cpf) {
    this._checarSessao();
    const cpfNorm = cpf.trim();

    if (cpfNorm === this._sessao.cpf) {
      return { ok: false, mensagem: 'Nao e possivel transferir para a propria conta.' };
    }

    const bancoDestino = this._bancos.find(b => b.cpf === cpfNorm);
    if (!bancoDestino) {
      return { ok: false, mensagem: `CPF "${cpfNorm}" nao encontrado no sistema.` };
    }

    return { ok: true, banco: { id: bancoDestino.id, nome: bancoDestino.nome, cpf: bancoDestino.cpf }, mensagem: '' };
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
      return { bloqueado: true, mensagem: `Acesso bloqueado. Tente em ${seg}s.` };
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

  getBancos() {
    this._checarInicio();
    return this._bancos.map(({ id, nome }) => ({ id, nome }));
  }

  login(cpf, senha) {
    this._checarInicio();
    const cpfNorm = cpf.trim();

    const bloqueio = this._checarBloqueio(cpfNorm);
    if (bloqueio.bloqueado) return { ok: false, mensagem: bloqueio.mensagem };

    const bancoEncontrado = this._bancos.find(
      b => b.cpf === cpfNorm && b.senha === senha.trim()
    );

    if (!bancoEncontrado) {
      const falha = this._registrarFalhaLogin(cpfNorm);
      if (falha.bloqueado) {
        return { ok: false, mensagem: `Credenciais incorretas. Acesso bloqueado por ${this._BLOQUEIO_MS / 1000}s.` };
      }
      return { ok: false, mensagem: `CPF ou senha incorretos. Tentativas restantes: ${falha.tentativasRestantes}.` };
    }

    this._resetarTentativas(cpfNorm);
    this._sessao = bancoEncontrado;
    return {
      ok: true,
      mensagem: `Bem-vindo(a) ao ${this._sessao.nome}!`,
      banco: { id: this._sessao.id, nome: this._sessao.nome }
    };
  }

  logout() {
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
        const valor = t.valorFormatado ? ` ${t.valorFormatado}` : '';
        const obs   = t.obs ? ` (${t.obs})` : '';
        console.info(`${i + 1}. [${t.dataHora}] ${t.tipo}${obs}${valor} | Saldo: ${t.saldoAposFormatado}`);
      });
    }
    console.groupEnd();
  }

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

    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('Banco 24h — Extrato Bancario', 14, 20);

    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`Banco: ${this._sessao.nome}`,                           14, 32);
    doc.text(`CPF: ${this._sessao.cpf}`,                              14, 39);
    doc.text(`Saldo atual: ${this._formatarBRL(this._sessao.saldo)}`, 14, 46);
    doc.text(`Gerado em: ${dataGeracao}`,                             14, 53);

    doc.setDrawColor(150, 150, 150);
    doc.line(14, 58, 196, 58);

    doc.setFontSize(10);
    let y = 66;

    if (historico.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.text('Nenhuma transacao registrada.', 14, y);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.text('#',           14, y);
      doc.text('Data/Hora',   22, y);
      doc.text('Tipo',        78, y);
      doc.text('Valor',      140, y);
      doc.text('Saldo Apos', 168, y);

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
        doc.text(t.valorFormatado || '—', 140, y);
        doc.text(t.saldoAposFormatado,    168, y);
        y += 8;
      });
    }

    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(150);
      doc.text(`Fintech Informatica — Gerado automaticamente — Pagina ${p} de ${total}`, 14, 290);
    }

    const nomeArquivo = `extrato_${this._sessao.id}_${Date.now()}.pdf`;
    doc.save(nomeArquivo);
    return { ok: true, mensagem: `PDF gerado: ${nomeArquivo}` };
  }

  // ============================================================
  //  OPERACOES FINANCEIRAS
  //  Recebem os valores ja validados e convertidos pela interface.
  //  Retornam { ok, mensagem } para a interface tratar.
  // ============================================================

  /**
   * @param {number} valor — ja validado
   */
  sacar(valor) {
    this._checarInicio();
    this._checarSessao();

    if (valor > this._sessao.saldo) {
      return { ok: false, mensagem: `Saldo insuficiente. Disponivel: ${this._formatarBRL(this._sessao.saldo)}` };
    }

    this._sessao.saldo -= valor;
    this._registrarTransacao(this._sessao.id, 'Saque', valor, this._sessao.saldo, '', 'debito');

    return { ok: true, mensagem: `Saque de ${this._formatarBRL(valor)} realizado.` };
  }

  /**
   * @param {number} valor — ja validado
   */
  depositar(valor) {
    this._checarInicio();
    this._checarSessao();

    this._sessao.saldo += valor;
    this._registrarTransacao(this._sessao.id, 'Deposito', valor, this._sessao.saldo, '', 'credito');

    return { ok: true, mensagem: `Deposito de ${this._formatarBRL(valor)} realizado.` };
  }

  /**
   * @param {string} cpfDestino — ja validado
   * @param {number} valor      — ja validado
   */
  transferir(cpfDestino, valor) {
    this._checarInicio();
    this._checarSessao();

    const bancoDestino = this._bancos.find(b => b.cpf === cpfDestino.trim());
    if (!bancoDestino) {
      return { ok: false, mensagem: 'Conta de destino nao encontrada.' };
    }

    if (valor > this._sessao.saldo) {
      return { ok: false, mensagem: `Saldo insuficiente. Disponivel: ${this._formatarBRL(this._sessao.saldo)}` };
    }

    this._sessao.saldo -= valor;
    bancoDestino.saldo += valor;

    this._registrarTransacao(
      this._sessao.id, 'Transferencia Enviada', valor, this._sessao.saldo,
      `para ${bancoDestino.nome}`, 'debito'
    );
    this._registrarTransacao(
      bancoDestino.id, 'Transferencia Recebida', valor, bancoDestino.saldo,
      `de ${this._sessao.nome}`, 'credito'
    );

    this._salvar();

    return {
      ok: true,
      mensagem: `Transferencia de ${this._formatarBRL(valor)} para ${bancoDestino.nome} realizada.`
    };
  }

  /**
   * @param {string} senhaAtual — senha atual em texto puro
   * @param {string} novaSenha  — nova senha em texto puro
   */
  trocarSenha(senhaAtual, novaSenha) {
    this._checarInicio();
    this._checarSessao();

    if (senhaAtual.trim() !== this._sessao.senha) {
      return { ok: false, mensagem: 'Senha atual incorreta.' };
    }

    if (!novaSenha || novaSenha.trim() === '') {
      return { ok: false, mensagem: 'A nova senha nao pode estar em branco.' };
    }

    this._sessao.senha = novaSenha.trim();
    this._registrarTransacao(this._sessao.id, 'Troca de Senha', null, this._sessao.saldo, '', 'neutro');

    return { ok: true, mensagem: 'Senha alterada com sucesso.' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BancoController;
}
