import { app } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface StorageData {
  [key: string]: any
}

export class StorageService {
  private dataPath: string
  private data: StorageData = {}

  constructor(fileName: string = 'app-data.json') {
    this.dataPath = join(app.getPath('userData'), fileName)
    this.loadData()
  }

  public get<T>(key: string, defaultValue: T): T {
    return this.data[key] !== undefined ? this.data[key] : defaultValue
  }

  public set(key: string, value: any): void {
    this.data[key] = value
    this.saveData()
  }

  public delete(key: string): void {
    delete this.data[key]
    this.saveData()
  }

  public has(key: string): boolean {
    return key in this.data
  }

  public clear(): void {
    this.data = {}
    this.saveData()
  }

  public getAll(): StorageData {
    return { ...this.data }
  }

  private loadData(): void {
    try {
      if (existsSync(this.dataPath)) {
        const fileContent = readFileSync(this.dataPath, 'utf-8')
        this.data = JSON.parse(fileContent)
      }
    } catch (error) {
      console.error('Failed to load storage data:', error)
      this.data = {}
    }
  }

  private saveData(): void {
    try {
      writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save storage data:', error)
    }
  }
}