// Small, uncompressed ZIP writer: package credentials only in the browser, never in a URL.
export function buildStoredZip(files) {
  const encoder = new TextEncoder()
  const local = [], central = []
  let offset = 0, centralSize = 0
  for (const [name, text] of Object.entries(files)) {
    const filename = encoder.encode(name), data = encoder.encode(text)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = new Uint8Array(30 + filename.length), h = new DataView(header.buffer)
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true)
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true)
    h.setUint16(26, filename.length, true); header.set(filename, 30)
    const entry = new Uint8Array(46 + filename.length), e = new DataView(entry.buffer)
    e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint16(8, 0x800, true)
    e.setUint32(16, crc, true); e.setUint32(20, data.length, true); e.setUint32(24, data.length, true)
    e.setUint16(28, filename.length, true); e.setUint32(42, offset, true); entry.set(filename, 46)
    local.push(header, data); central.push(entry)
    offset += header.length + data.length; centralSize += entry.length
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true)
  e.setUint32(12, centralSize, true); e.setUint32(16, offset, true)
  return new Blob([...local, ...central, end], { type: 'application/zip' })
}

export function installerFiles(credential, origin, installer, agent) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('安装包需要 HTTPS 服务器地址')
  return {
    'Install.cmd': '@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-FieldDesk-Print-Agent.ps1"\r\npause\r\n',
    'Install-FieldDesk-Print-Agent.ps1': '\uFEFF' + installer.replace(/^\uFEFF/, ''),
    'FieldDesk-Print-Agent.ps1': '\uFEFF' + agent.replace(/^\uFEFF/, ''),
    'setup.json': JSON.stringify({ apiBaseUrl: url.origin, terminalId: credential.terminal.id, terminalToken: credential.token, printerName: credential.terminal.printerName }),
    'README.txt': '\uFEFF解压全部文件后双击 Install.cmd，允许 Windows 管理员授权。无需填写地址或密钥。\r\n请先安装打印机驱动。找不到预设打印机时，安装程序会让您选择。\r\n安装完成后删除下载的 ZIP 和解压目录（包含终端密钥），不要转发。\r\n换电脑请在网页生成新的安装包，旧电脑先退出打印助手。\r\n'
  }
}
