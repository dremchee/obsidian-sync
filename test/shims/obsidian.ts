export class TAbstractFile {
  path = "";
}

export class TFile extends TAbstractFile {
  stat = { mtime: 0 };
}
